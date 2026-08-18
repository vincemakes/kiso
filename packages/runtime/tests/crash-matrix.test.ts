/**
 * R-F 0.1.46-3 — the EffectGate + the deterministic crash matrix.
 *
 * The EffectGate is a TEST-ONLY crash injector at the four effect
 * boundaries (persist / model / tool / human): park(point) arms a hold on
 * the NEXT effect at that boundary — the crash point; peek() names the
 * oldest held effect; executeOne() releases it. The durable state is
 * everything BEFORE the held boundary: the hold IS the process death, at
 * a deterministic point in the trajectory.
 *
 * Each matrix row: a live trajectory → a crash (before or after one
 * boundary) → reopen (a fresh handle adopts the durable prefix) →
 * deriveRecoveryPlan over the prefix → continue to the terminal. The
 * repair-write rows (R1/R2) crash the recovery's OWN appends — a repair
 * write dies, the reopen derives the SAME action, the repair lands
 * exactly once. Every row asserts the plan AT the crash state.
 *
 * The real SIGKILL e2e (scripts/demo-kill9.sh) stays the OS-layer
 * evidence; this matrix is the deterministic, per-boundary exhaustive
 * complement, and it runs inside `npm run check`.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool, type Adapter, type AdapterEvent, type Event, type Tool } from "@vincemakes/kiso-core";
import { createAgent, type AgentSession, SessionStore } from "../src/index.js";
import { deriveRecoveryPlan, type RecoveryAction } from "../src/recovery-plan.js";

// ── the EffectGate ────────────────────────────────────────────────────────

class EffectGate {
	#armed = new Set<string>();
	#held: Array<{ point: string; release: () => void }> = [];
	#waiters: Array<(point: string) => void> = [];

	/** Arm a hold on the NEXT effect at this boundary. */
	park(point: string): void {
		this.#armed.add(point);
	}
	/** The oldest held effect, if any. */
	peek(): string | undefined {
		return this.#held[0]?.point;
	}
	heldCount(): number {
		return this.#held.length;
	}
	/** Release the oldest held effect — the crash-after landing. */
	executeOne(): void {
		const held = this.#held.shift();
		if (held === undefined) throw new Error("the gate holds nothing — park() before the effect");
		held.release();
	}
	/** Resolves with the point of the NEXT hold (an already-held one now). */
	waitHeld(): Promise<string> {
		if (this.#held.length > 0) return Promise.resolve(this.#held[0]!.point);
		return new Promise((resolve) => this.#waiters.push(resolve));
	}
	/** The effect: hold when armed (the crash), then run the effect. */
	async boundary<T>(point: string, effect: () => Promise<T>): Promise<T> {
		if (this.#armed.has(point)) {
			this.#armed.delete(point);
			await new Promise<void>((release) => {
				this.#held.push({ point, release });
				this.#waiters.splice(0).forEach((w) => w(point));
			});
		}
		return effect();
	}
}

/** Wrap the session's effect entry points (persist / the human decisions). */
function gatedSession(session: AgentSession, gate: EffectGate): void {
	const realPersist = session.persist.bind(session);
	session.persist = (runId, event) => gate.boundary("persist", () => realPersist(runId, event));
	const realApprove = session.approve.bind(session);
	session.approve = (decisionId, allow, reason) => gate.boundary("human", () => realApprove(decisionId, allow, reason));
	const realResolve = session.resolveUncertain.bind(session);
	session.resolveUncertain = (executionId, resolution) =>
		gate.boundary("human", () => realResolve(executionId, resolution));
}

/** Wrap the adapter: the provider call holds BEFORE the stream is created. */
function gatedAdapter(gate: EffectGate, adapter: Adapter): Adapter {
	const realStream = adapter.stream.bind(adapter);
	return {
		stream(options) {
			return {
				async *[Symbol.asyncIterator]() {
					await gate.boundary("model", async () => {});
					yield* realStream(options);
				},
			};
		},
	};
}

/** Wrap a tool: the world-effect holds BEFORE execute runs. */
function gatedTool(gate: EffectGate, tool: Tool<{ query: string }>): Tool<{ query: string }> {
	const execute = tool.execute.bind(tool);
	return {
		...tool,
		execute: (input, ctx) => gate.boundary("tool", () => execute(input, ctx)),
	};
}

// ── trajectory helpers ────────────────────────────────────────────────────

/** Step the run until the gate holds an effect, or the run COMPLETES
 *  (the iterator's next() resolves with done:true — a yielded event is
 *  just a step, not the end). */
async function stepUntilHold(it: AsyncIterator<Event>, gate: EffectGate): Promise<"held" | "done"> {
	const held = gate.waitHeld();
	for (;;) {
		const raced = await Promise.race([
			it.next().then((r) => (r.done ? "done" : "step") as "done" | "step"),
			held.then(() => "held" as const),
		]);
		if (raced !== "step") return raced;
	}
}

/** Step the run until an event of the given type appears (the run pauses
 *  behind it when the loop's own await holds it). */
async function nextEventOfType<T extends Event["type"]>(it: AsyncIterator<Event>, type: T): Promise<Event & { type: T }> {
	for (;;) {
		const r = await it.next();
		if (r.done) throw new Error(`the run completed before a ${type}`);
		if (r.value.type === type) return r.value as Event & { type: T };
	}
}

/** The process dies: the run is abandoned at the held boundary — the
 *  generator's cleanup (return()) can NEVER run, because the iterator is
 *  blocked INSIDE the held effect's await: return() would queue behind the
 *  hold and hang forever, while a real SIGKILL waits for nothing. Dropping
 *  the iterator is exactly the crash — no finally, no flush, the durable
 *  prefix is everything BEFORE the held boundary. */
async function processDeath(_it: AsyncIterator<Event>): Promise<void> {
	// no it.return() — the process died, no cleanup ran
}

const recordsOf = (dir: string, id = "s"): readonly Event[] => new SessionStore(dir).load(id).map((r) => r.event);
/** The plan the recovery would derive over the durable prefix AT the crash. */
const planAt = (dir: string): RecoveryAction => {
	const events = recordsOf(dir);
	return deriveRecoveryPlan(events, events);
};
const terminalOf = (events: readonly Event[]) => events.find((e) => e.type === "terminal");
const callSeqOf = (events: readonly Event[]): number => events.find((e) => e.type === "tool_call_end")!.seq;

/** Resume and collect; the consumer answers any re-presented request. */
async function drain(
	session: AgentSession,
	approve: (ev: Event & { type: "permission_requested" }) => Promise<void>,
): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of session.resume()) {
		events.push(ev);
		if (ev.type === "permission_requested") await approve(ev);
	}
	return events;
}

/** A scripted provider: one turn per call, the last repeated. */
function scriptedAdapter(turns: ReadonlyArray<ReadonlyArray<AdapterEvent>>): {
	adapter: Adapter;
	streamCalls: number[];
} {
	const streamCalls: number[] = [];
	const adapter: Adapter = {
		stream(options) {
			streamCalls.push(options.messages.length);
			const turn = turns[Math.min(streamCalls.length - 1, turns.length - 1)] ?? [];
			return {
				async *[Symbol.asyncIterator]() {
					for (const ev of turn) yield ev;
				},
			};
		},
	};
	return { adapter, streamCalls };
}

/** A tool whose side effect is a marker file — observable across the crash. */
function markerTool(markerPath: string): { tool: Tool<{ query: string }>; calls: () => number } {
	let calls = 0;
	const tool = defineTool<{ query: string }>({
		name: "web_search",
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		execute: async (input) => {
			calls++;
			writeFileSync(markerPath, input.query, "utf8");
			return { content: `results for ${input.query}`, isError: false };
		},
	});
	return { tool, calls: () => calls };
}

const CALLING_TURN: readonly AdapterEvent[] = [
	{ type: "text_delta", text: "checking", seq: 0 },
	{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" }, seq: 1 },
	{ type: "stop", reason: "tool_use", seq: 2 },
];
const DONE_TURN: readonly AdapterEvent[] = [{ type: "stop", reason: "end_turn", seq: 0 }];

/** The reopen: the process restarted — fresh handles adopt the prefix. */
function reopenAgent(dir: string, adapter: Adapter, tool?: Tool<{ query: string }>, defer = false) {
	const agent = createAgent({
		model: "faux",
		store: new SessionStore(dir),
		tools: tool !== undefined ? [tool] : [],
		adapter,
		...(defer ? { permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] as const } } : {}),
	});
	return agent.session({ id: "s" });
}

describe("the crash matrix (R-F 0.1.46-3): the four effect boundaries, crash-before and crash-after", () => {
	it("P1 — persist crash-BEFORE: the prompt's write never landed — the plan is COMPLETED, a fresh run walks the same program", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-p1-"));
		const gate = new EffectGate();
		const { adapter } = scriptedAdapter([DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter }).session({ id: "s" });
		gatedSession(session, gate);
		gate.park("persist");

		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held");
		expect(gate.peek()).toBe("persist");
		// the crash state: NOTHING durable — the write never reached the store
		expect(recordsOf(dir)).toEqual([]);
		expect(planAt(dir)).toEqual({ kind: "COMPLETED" });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		// reopen: nothing to recover — a FRESH run drives the same program
		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.run("go")) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		expect(recordsOf(dir).filter((e) => e.type === "user_input")).toHaveLength(1);
	});

	it("P2 — persist crash-AFTER: the prompt landed, the turn's write never did — CONTINUE_MODEL re-drives, exactly one prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-p2-"));
		const gate = new EffectGate();
		const { adapter, streamCalls } = scriptedAdapter([DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter }).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("persist");
		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held"); // the prompt's write
		gate.executeOne();
		gate.park("persist");
		expect(await stepUntilHold(it, gate)).toBe("held"); // the turn's first write

		const events = recordsOf(dir);
		expect(events.filter((e) => e.type === "user_input")).toHaveLength(1);
		expect(events.some((e) => e.type === "stop")).toBe(false); // the turn never landed
		expect(planAt(dir)).toEqual({ kind: "CONTINUE_MODEL" });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter);
		const events2: Event[] = [];
		for await (const ev of session2.resume()) events2.push(ev);
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(recordsOf(dir).filter((e) => e.type === "user_input")).toHaveLength(1); // never duplicated
		expect(streamCalls.length).toBe(2); // once live, once on the resume
	});

	it("M1 — model crash-BEFORE: the provider was never called — CONTINUE_MODEL re-calls it on the resume", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-m1-"));
		const gate = new EffectGate();
		const { adapter: scripted, streamCalls } = scriptedAdapter([DONE_TURN]);
		const adapter = gatedAdapter(gate, scripted);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter }).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("model");
		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held");
		expect(gate.peek()).toBe("model");
		expect(streamCalls.length).toBe(0); // the provider never called
		expect(recordsOf(dir).filter((e) => e.type === "user_input")).toHaveLength(1); // the prompt durable
		expect(planAt(dir)).toEqual({ kind: "CONTINUE_MODEL" });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.resume()) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		expect(streamCalls.length).toBe(1); // the resume re-drove the model — the same program
	});

	it("M2 — model crash-AFTER: the provider answered, the turn never landed — the resume re-drives, nothing duplicated", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-m2-"));
		const gate = new EffectGate();
		const { adapter: scripted, streamCalls } = scriptedAdapter([DONE_TURN]);
		const adapter = gatedAdapter(gate, scripted);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter }).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("model");
		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held"); // the provider call
		gate.park("persist"); // armed BEFORE the release: the turn's first write is the crash point
		gate.executeOne();
		expect(await stepUntilHold(it, gate)).toBe("held"); // the turn's first write
		expect(streamCalls.length).toBe(1); // the provider answered — exactly once (the stream ran before the held write)

		const events = recordsOf(dir);
		expect(events.filter((e) => e.type === "user_input")).toHaveLength(1);
		expect(events.some((e) => e.type === "stop")).toBe(false); // the turn's events never landed
		expect(planAt(dir)).toEqual({ kind: "CONTINUE_MODEL" });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter);
		const events2: Event[] = [];
		for await (const ev of session2.resume()) events2.push(ev);
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(streamCalls.length).toBe(2);
		expect(recordsOf(dir).filter((e) => e.type === "stop")).toHaveLength(1); // exactly one terminal turn
	});

	it("T1 — tool crash-BEFORE: the execution started durable, the effect never ran — RESOLVE_UNCERTAIN, the human abandons", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-t1-"));
		const gate = new EffectGate();
		const marker = join(dir, "effect.txt");
		const { tool, calls } = markerTool(marker);
		const { adapter } = scriptedAdapter([CALLING_TURN, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({
			model: "faux",
			store: live,
			tools: [gatedTool(gate, tool)],
			adapter,
		}).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("tool");
		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held");
		expect(gate.peek()).toBe("tool");
		// the crash state: the STARTED is durable; the effect never ran
		const events = recordsOf(dir);
		const started = events.find((e) => e.type === "tool_execution_started");
		expect(started).toBeDefined();
		expect(calls()).toBe(0);
		expect(existsSync(marker)).toBe(false);
		expect(planAt(dir)).toEqual({ kind: "RESOLVE_UNCERTAIN", executionId: started!.executionId });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		// the uncertain execution blocks the resume — the human decides
		const session2 = await reopenAgent(dir, adapter, tool);
		await expect(drain(session2, async () => {})).rejects.toThrow(/uncertain/);
		await session2.resolveUncertain(started!.executionId, "abandoned");
		const events2 = await drain(session2, async () => {});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(calls()).toBe(0); // abandoned: the effect never ran, never rerun
		expect(recordsOf(dir).filter((e) => e.type === "tool_result" && e.executionId === started!.executionId)).toHaveLength(1);
	});

	it("T2 — tool crash-AFTER: the effect ran, the receipt never landed — RESOLVE_UNCERTAIN, the side effect stays", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-t2-"));
		const gate = new EffectGate();
		const marker = join(dir, "effect.txt");
		const { tool, calls } = markerTool(marker);
		const { adapter } = scriptedAdapter([CALLING_TURN, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({
			model: "faux",
			store: live,
			tools: [gatedTool(gate, tool)],
			adapter,
		}).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("tool");
		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held");
		gate.park("persist"); // armed BEFORE the release: the receipt's write is the crash point
		gate.executeOne();
		expect(await stepUntilHold(it, gate)).toBe("held"); // the receipt's write
		expect(calls()).toBe(1);
		expect(existsSync(marker)).toBe(true); // the effect applied — the crash-after

		const events = recordsOf(dir);
		const started = events.find((e) => e.type === "tool_execution_started");
		expect(started).toBeDefined();
		expect(events.some((e) => e.type === "tool_execution_succeeded")).toBe(false); // the receipt write held
		expect(planAt(dir)).toEqual({ kind: "RESOLVE_UNCERTAIN", executionId: started!.executionId });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter, tool);
		await expect(drain(session2, async () => {})).rejects.toThrow(/uncertain/);
		await session2.resolveUncertain(started!.executionId, "abandoned");
		const events2 = await drain(session2, async () => {});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(existsSync(marker)).toBe(true); // the side effect stays — the honest crash-after
	});

	it("H1 — human crash-BEFORE: the verdict never delivered — WAIT_PERMISSION re-asks on the resume", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-h1-"));
		const gate = new EffectGate();
		const marker = join(dir, "effect.txt");
		const { tool } = markerTool(marker);
		const { adapter } = scriptedAdapter([CALLING_TURN, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({
			model: "faux",
			store: live,
			tools: [tool],
			adapter,
			permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
		}).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("human");
		const it = session.run("go")[Symbol.asyncIterator]();
		await it.next(); // the prompt
		const pause = await nextEventOfType(it, "permission_requested"); // the request — the run pauses
		const inFlight = session.approve(pause.decisionId, true); // the human answers — held at the gate
		expect(await gate.waitHeld()).toBe("human");

		const events = recordsOf(dir);
		expect(events.filter((e) => e.type === "permission_requested")).toHaveLength(1);
		expect(events.some((e) => e.type === "permission_decided")).toBe(false); // the verdict never delivered
		expect(planAt(dir)).toEqual({ kind: "WAIT_PERMISSION", invocationSeq: callSeqOf(events) });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		// the SAME request is re-announced; the human answers for real
		const session2 = await reopenAgent(dir, adapter, tool, true);
		let reasked = 0;
		const events2 = await drain(session2, async (ev) => {
			reasked++;
			await session2.approve(ev.decisionId, true);
		});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(reasked).toBe(1); // the re-ask — the request was never lost
		expect(recordsOf(dir).filter((e) => e.type === "permission_decided")).toHaveLength(1); // exactly one decision
	});

	it("H2 — human crash-AFTER: the decision landed durable — the resume NEVER re-asks, it EXECUTEs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-h2-"));
		const gate = new EffectGate();
		const marker = join(dir, "effect.txt");
		const { tool, calls } = markerTool(marker);
		const { adapter } = scriptedAdapter([CALLING_TURN, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({
			model: "faux",
			store: live,
			tools: [tool],
			adapter,
			permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
		}).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("human");
		const it = session.run("go")[Symbol.asyncIterator]();
		await it.next(); // the prompt
		const pause = await nextEventOfType(it, "permission_requested"); // the request — the run pauses
		void session.approve(pause.decisionId, true);
		expect(await gate.waitHeld()).toBe("human");
		gate.executeOne(); // the verdict delivered
		// EC-1 ③ (the SCHEDULER-TIMING class): the post-pause persist order
		// lost its first step. It used to be stop → decided → execution,
		// because the ask fired mid-stream and the turn's stop landed after
		// the human answered. The ask now waits for Turn Commit, so the stop
		// is ALREADY durable when the request is put to a person — what
		// follows the verdict is the decided's write, then the execution's:
		// two crash candidates, not three. The crash POINT this row tests is
		// unchanged — after the decision is durable, before the execution.
		gate.park("persist");
		expect(await stepUntilHold(it, gate)).toBe("held"); // the decided's write
		gate.executeOne(); // the decision durable
		gate.park("persist");
		expect(await stepUntilHold(it, gate)).toBe("held"); // the execution's write — THE CRASH

		const events = recordsOf(dir);
		expect(events.some((e) => e.type === "permission_decided" && e.decision === "approved")).toBe(true);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false); // the execution write held
		expect(planAt(dir)).toEqual({ kind: "EXECUTE", invocationSeq: callSeqOf(events) });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		// the resume announces NOTHING — the decision survived the crash
		const session2 = await reopenAgent(dir, adapter, tool, true);
		let reasked = 0;
		const events2 = await drain(session2, async (ev) => {
			reasked++;
			await session2.approve(ev.decisionId, true);
		});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(reasked).toBe(0); // never re-asked
		expect(calls()).toBe(1); // the EXECUTE ran the tool once
		expect(recordsOf(dir).filter((e) => e.type === "permission_decided")).toHaveLength(1);
	});

	it("H3 — human crash BETWEEN: the verdict delivered, its durability never landed — the resume re-asks safely", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-h3-"));
		const gate = new EffectGate();
		const marker = join(dir, "effect.txt");
		const { tool, calls } = markerTool(marker);
		const { adapter } = scriptedAdapter([CALLING_TURN, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({
			model: "faux",
			store: live,
			tools: [tool],
			adapter,
			permissionPolicy: { rules: [{ tool: "web_search", action: "defer" }] },
		}).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("human");
		const it = session.run("go")[Symbol.asyncIterator]();
		await it.next(); // the prompt
		const pause = await nextEventOfType(it, "permission_requested"); // the request — the run pauses
		void session.approve(pause.decisionId, true);
		expect(await gate.waitHeld()).toBe("human");
		gate.executeOne(); // the verdict delivered
		// EC-1 ③ (the SCHEDULER-TIMING class): the stop's write no longer
		// sits between the delivery and the decision — the ask happens after
		// Turn Commit, so the turn is already closed when the human is asked.
		// The crash still lands BETWEEN the delivery and the decision's
		// durability; it is now the very next persist.
		gate.park("persist");
		expect(await stepUntilHold(it, gate)).toBe("held"); // the decided's write — THE CRASH

		const events = recordsOf(dir);
		expect(events.some((e) => e.type === "permission_decided")).toBe(false); // the decision died with the process
		expect(planAt(dir)).toEqual({ kind: "WAIT_PERMISSION", invocationSeq: callSeqOf(events) });

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter, tool, true);
		let reasked = 0;
		const events2 = await drain(session2, async (ev) => {
			reasked++;
			await session2.approve(ev.decisionId, true);
		});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(reasked).toBe(1); // the re-ask — the human answers again
		expect(calls()).toBe(1); // the tool ran exactly once across both processes
		expect(recordsOf(dir).filter((e) => e.type === "permission_decided")).toHaveLength(1);
	});

	it("R1 — the repair-write crash: the ABANDON_DRAFT marker's write dies — the next reopen derives the SAME action, lands exactly one marker", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-r1-"));
		const gate = new EffectGate();
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "text_delta", text: "let me draft" },
			{ seq: 2, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },
			{ seq: 3, type: "text_delta", text: "still drafting" },
		];
		const store = new SessionStore(dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		expect(planAt(dir)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 0 });

		const { adapter } = scriptedAdapter([DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter }).session({ id: "s" });
		gatedSession(session, gate);
		gate.park("persist");
		const it = session.resume()[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held"); // the marker's write
		expect(recordsOf(dir).some((e) => e.type === "model_output_abandoned")).toBe(false);
		expect(planAt(dir)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 0 }); // STILL the same action

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.resume()) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		expect(recordsOf(dir).filter((e) => e.type === "model_output_abandoned")).toHaveLength(1); // exactly one marker
		expect(recordsOf(dir).some((e) => e.type === "tool_execution_started")).toBe(false); // the draft's call never executed
	});

	it("R2 — the repair-write crash: the RECEIPT repair's write dies — re-derives the SAME repair, lands exactly one result", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-r2-"));
		const gate = new EffectGate();
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },
			{ seq: 2, type: "permission_decided", decisionId: "d1", callId: "c1", decision: "approved", decidedBy: "mode:default" },
			{ seq: 3, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: { query: "k" } },
			{ seq: 4, type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", result: { content: "receipt", isError: false } },
		];
		const store = new SessionStore(dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		expect(planAt(dir)).toEqual({ kind: "REPAIR_RESULT", executionId: "ex-1" });

		const { adapter } = scriptedAdapter([DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [], adapter }).session({ id: "s" });
		gatedSession(session, gate);
		gate.park("persist");
		const it = session.resume()[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held"); // the repair's write
		expect(recordsOf(dir).some((e) => e.type === "tool_result" && e.executionId === "ex-1")).toBe(false);
		expect(planAt(dir)).toEqual({ kind: "REPAIR_RESULT", executionId: "ex-1" }); // STILL the same repair

		await processDeath(it);
		live.closeAll(); // the old process released its writer lock

		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.resume()) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		expect(recordsOf(dir).filter((e) => e.type === "tool_result" && e.executionId === "ex-1")).toHaveLength(1);
	});
});
