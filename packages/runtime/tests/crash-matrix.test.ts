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

/** EC-1 ⑥ — an adapter whose stream yields its whole turn and then HANGS
 *  before the iterator completes. That window is exactly the stop-hold: the
 *  stop has arrived and is held in memory, the kernel is still draining, and
 *  no durable stop exists. Crash-pair A lives here and nowhere else — the
 *  gated adapter above holds BEFORE the stream, which is a different crash. */
function holdAfterStreamAdapter(gate: EffectGate, turn: readonly AdapterEvent[]): Adapter {
	return {
		stream() {
			return {
				async *[Symbol.asyncIterator]() {
					for (const ev of turn) yield ev;
					await gate.boundary("model", async () => {}); // the stream never ends — the stop stays held
				},
			};
		},
	};
}

/** A tool whose side effect is one marker file PER CALL — two calls in one
 *  turn have to be told apart to see which of them actually ran. `effects`
 *  is passed through so a cell can build the exclusive/shared pair the FIFO
 *  barrier is about. */
function perCallMarkerTool(
	dir: string,
	name = "web_search",
	effects?: Tool["effects"],
): { tool: Tool<{ query: string }>; ran: () => string[] } {
	const ran: string[] = [];
	const tool = defineTool<{ query: string }>({
		name,
		description: "Search",
		parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		...(effects !== undefined ? { effects } : {}),
		execute: async (input) => {
			ran.push(input.query);
			writeFileSync(join(dir, `effect-${input.query}.txt`), input.query, "utf8");
			return { content: `results for ${input.query}`, isError: false };
		},
	});
	return { tool, ran: () => ran };
}

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

// ── EC-1 ⑥ — the commit boundary's own crash cells ────────────────────────
//
// The matrix above was built around three durable boundaries: the persist,
// the model call, the tool effect, the human verdict. EC-1 adds a fourth —
// the DURABLE TURN COMMIT — and with it a new class of crash window that did
// not exist before: the stop is HELD in memory while the stream drains, so a
// process can now die with a complete tool call on disk and no stop after
// it. Pre-EC-1 that window was microseconds wide (the stop was persisted the
// instant it arrived); it is now the whole stream tail.
//
// The four cells below are the boundary's crash surface, one per waiting
// state a call can be in: held stop, held barrier, committed-not-launched,
// held ask. Their common claim is the one ① exists to make — WAITING IS NOT
// STARTING. In every cell the interrupted call has emitted no started event,
// so nothing is uncertain and nothing needs a human to adjudicate reality.
describe("EC-1 ⑥ — the crash cells of the Turn Commit boundary", () => {
	it("crash A/B — the pair: the two durable prefixes differ by EXACTLY ONE STOP, and that one event decides whether the call may run", async () => {
		// The round's showcase proof, asserted literally rather than
		// described. Both arms run the SAME trajectory through the SAME
		// scripted turn; the only difference is where the process dies.
		//
		//   A: the stop arrived, the iterator is NOT done — kill -9.
		//   B: the iterator is done, the stop is persisted — kill -9 before
		//      anything started.
		//
		// A's prefix must be B's prefix minus its last event, byte for byte,
		// and that last event must be the stop. Everything else about the two
		// crashes is identical, so the recovery verdicts that follow are
		// attributable to that single durable fact and to nothing else.

		// ── arm A: killed during the stop-hold ──
		const dirA = mkdtempSync(join(tmpdir(), "kiso-mx-a-"));
		const gateA = new EffectGate();
		const { tool: toolA, calls: callsA } = markerTool(join(dirA, "effect.txt"));
		const liveA = new SessionStore(dirA);
		const sessionA = await createAgent({
			model: "faux",
			store: liveA,
			tools: [toolA],
			adapter: holdAfterStreamAdapter(gateA, CALLING_TURN),
		}).session({ id: "s" });
		gateA.park("model");
		const itA = sessionA.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(itA, gateA)).toBe("held");

		const prefixA = recordsOf(dirA);
		// The crash state: the call is durable, the stop is NOT, and no
		// effectful started event exists.
		expect(prefixA.some((e) => e.type === "tool_call_end")).toBe(true);
		expect(prefixA.some((e) => e.type === "stop")).toBe(false);
		expect(prefixA.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(callsA()).toBe(0);
		// An uncommitted turn is a DRAFT — never an invocation to execute.
		expect(planAt(dirA)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 0 });

		await processDeath(itA);
		liveA.closeAll();

		// ── arm B: killed after the commit, before anything started ──
		const dirB = mkdtempSync(join(tmpdir(), "kiso-mx-b-"));
		const gateB = new EffectGate();
		const { tool: toolB, calls: callsB } = markerTool(join(dirB, "effect.txt"));
		const { adapter: adapterB } = scriptedAdapter([CALLING_TURN, DONE_TURN]);
		const liveB = new SessionStore(dirB);
		const sessionB = await createAgent({ model: "faux", store: liveB, tools: [toolB], adapter: adapterB }).session({ id: "s" });
		gatedSession(sessionB, gateB);
		const itB = sessionB.run("go")[Symbol.asyncIterator]();
		await nextEventOfType(itB, "stop"); // the commit itself: the stop is now durable
		gateB.park("persist");
		expect(await stepUntilHold(itB, gateB)).toBe("held"); // the next write — THE CRASH

		const prefixB = recordsOf(dirB);
		expect(prefixB.some((e) => e.type === "stop")).toBe(true);
		expect(prefixB.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(callsB()).toBe(0);
		// A committed call re-enters the ORDINARY approval pipeline — the
		// same program a fresh call walks.
		expect(planAt(dirB)).toEqual({ kind: "DECIDE_PERMISSION", invocationSeq: callSeqOf(prefixB) });

		// ── the pair, asserted as bytes ──
		expect(JSON.stringify(prefixB.slice(0, prefixA.length))).toBe(JSON.stringify(prefixA));
		expect(prefixB).toHaveLength(prefixA.length + 1);
		expect(prefixB.at(-1)!.type).toBe("stop");

		await processDeath(itB);
		liveB.closeAll();

		// ── and the two resumes diverge exactly as the one event says ──
		const resumeA = await drain(await reopenAgent(dirA, scriptedAdapter([DONE_TURN]).adapter, toolA), async () => {});
		expect(terminalOf(resumeA)).toMatchObject({ outcome: { kind: "completed" } });
		expect(callsA()).toBe(0); // A never executes: the draft is voided
		expect(recordsOf(dirA).some((e) => e.type === "model_output_abandoned")).toBe(true);

		const resumeB = await drain(await reopenAgent(dirB, adapterB, toolB), async () => {});
		expect(terminalOf(resumeB)).toMatchObject({ outcome: { kind: "completed" } });
		expect(callsB()).toBe(1); // B executes, exactly once
		expect(recordsOf(dirB).filter((e) => e.type === "tool_execution_started")).toHaveLength(1);
	});

	it("C1 — crash during the BARRIER DRAIN: the sibling held behind an exclusive call has no started receipt, and runs on the resume", async () => {
		// Two undeclared calls in one committed turn: absence is the
		// conservative truth, so the second waits behind the first's FIFO
		// barrier. The process dies while the first is inside its handler.
		// The claim: waiting consumes no execution slot AND leaves no trace —
		// the held sibling is clean, not uncertain, so the human is asked
		// about ONE interrupted execution, never two.
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-c1-"));
		const gate = new EffectGate();
		const { tool, ran } = perCallMarkerTool(dir);
		const TWO_CALLS: readonly AdapterEvent[] = [
			{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "one" }, seq: 0 },
			{ type: "tool_call_end", callId: "c2", name: "web_search", input: { query: "two" }, seq: 1 },
			{ type: "stop", reason: "tool_use", seq: 2 },
		];
		const { adapter } = scriptedAdapter([TWO_CALLS, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [gatedTool(gate, tool)], adapter }).session({ id: "s" });
		gatedSession(session, gate);

		gate.park("tool");
		const it = session.run("go")[Symbol.asyncIterator]();
		expect(await stepUntilHold(it, gate)).toBe("held");
		expect(gate.peek()).toBe("tool");

		const events = recordsOf(dir);
		const started = events.filter((e) => e.type === "tool_execution_started");
		// EXACTLY ONE started: the first call is inside its handler, the
		// second is held at the barrier and has emitted nothing.
		expect(started).toHaveLength(1);
		expect(started[0]!.callId).toBe("c1");
		expect(ran()).toEqual([]); // the gate holds the first BEFORE its effect
		expect(gate.heldCount()).toBe(1); // and the second never reached the boundary at all
		expect(planAt(dir)).toEqual({ kind: "RESOLVE_UNCERTAIN", executionId: started[0]!.executionId });

		await processDeath(it);
		live.closeAll();

		// The human adjudicates the ONE interrupted execution; the barrier's
		// waiter is an ordinary committed call and simply runs.
		const session2 = await reopenAgent(dir, adapter, tool);
		await expect(drain(session2, async () => {})).rejects.toThrow(/uncertain/);
		await session2.resolveUncertain(started[0]!.executionId, "abandoned");
		const events2 = await drain(session2, async () => {});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(ran()).toEqual(["two"]); // only the held sibling ran; the abandoned one was never rerun
		expect(existsSync(join(dir, "effect-one.txt"))).toBe(false);
		expect(existsSync(join(dir, "effect-two.txt"))).toBe(true);
	});

	it("C2 — crash BETWEEN the commit and an EXCLUSIVE LAUNCH: neither the exclusive call nor the shared sibling behind its barrier left a receipt", async () => {
		// The window ③ opens by design: the turn is committed, the handler
		// has not been entered, and a barrier is already installed — the
		// sibling declared `concurrency: "shared"` but was ACCEPTED after an
		// exclusive invocation, so it is waiting too (the FIFO fence). The
		// process dies with a fence in memory and nothing in the world.
		//
		// The claim, and the reason this is not crash B with an extra call:
		// the barrier is scheduler state, and scheduler state does NOT
		// survive a crash — nor does it need to. Both calls are ordinary
		// committed invocations on disk, neither is uncertain, and the resume
		// re-derives the same order from the same durable prefix.
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-c2-"));
		const gate = new EffectGate();
		const { tool: exclusive, ran: ranX } = perCallMarkerTool(dir, "web_search");
		// Shared, but NOT precommitSafe: it is commit-required like everything
		// else, and it queues behind the exclusive call accepted before it.
		const { tool: shared, ran: ranS } = perCallMarkerTool(dir, "read_thing", { concurrency: "shared" });
		const MIXED_TURN: readonly AdapterEvent[] = [
			{ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "x" }, seq: 0 },
			{ type: "tool_call_end", callId: "c2", name: "read_thing", input: { query: "s" }, seq: 1 },
			{ type: "stop", reason: "tool_use", seq: 2 },
		];
		const { adapter } = scriptedAdapter([MIXED_TURN, DONE_TURN]);
		const live = new SessionStore(dir);
		const session = await createAgent({ model: "faux", store: live, tools: [exclusive, shared], adapter }).session({ id: "s" });
		gatedSession(session, gate);

		const it = session.run("go")[Symbol.asyncIterator]();
		await nextEventOfType(it, "stop"); // the commit
		gate.park("persist");
		expect(await stepUntilHold(it, gate)).toBe("held"); // the exclusive call's started write — THE CRASH

		const events = recordsOf(dir);
		expect(events.some((e) => e.type === "stop")).toBe(true);
		expect(events.filter((e) => e.type === "tool_call_end")).toHaveLength(2);
		// The whole cell: a committed, un-launched exclusive call leaves NO
		// started receipt — and neither does the sibling its fence is holding.
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(ranX()).toEqual([]);
		expect(ranS()).toEqual([]);
		expect(planAt(dir)).toEqual({ kind: "DECIDE_PERMISSION", invocationSeq: callSeqOf(events) });

		await processDeath(it);
		live.closeAll();

		const agent2 = createAgent({ model: "faux", store: new SessionStore(dir), tools: [exclusive, shared], adapter });
		const session2 = await agent2.session({ id: "s" });
		const events2 = await drain(session2, async () => {});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		// Both ran, exactly once each, in CALL order — the fence's order is
		// re-derived from the log, never restored from memory.
		expect(ranX()).toEqual(["x"]);
		expect(ranS()).toEqual(["s"]);
		const started = recordsOf(dir).filter((e) => e.type === "tool_execution_started");
		expect(started.map((e) => e.callId)).toEqual(["c1", "c2"]);
	});

	it("C3 — crash during a HELD POST-COMMIT ASK: the request is durable and the stop is ALREADY before it", async () => {
		// H1 pinned the same recovery verdict before EC-1, but the durable
		// shape it crashed into was different: the ask fired mid-stream, so a
		// pending request could sit in a log with NO stop after the call.
		// ③ moved the ask behind the commit, so this cell adds the ordering
		// claim H1 could not make — a person was asked only about a turn that
		// had already proven valid — and the pre-EC-1 shape survives only as
		// the generation-compat clause in recovery-plan.ts.
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-c3-"));
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

		const it = session.run("go")[Symbol.asyncIterator]();
		const pause = await nextEventOfType(it, "permission_requested"); // the run holds for the human — THE CRASH STATE

		const events = recordsOf(dir);
		const stopSeq = events.find((e) => e.type === "stop")!.seq;
		const requestSeq = events.find((e) => e.type === "permission_requested")!.seq;
		// The ordering claim: the turn was committed BEFORE the question.
		expect(requestSeq).toBeGreaterThan(stopSeq);
		expect(events.some((e) => e.type === "permission_decided")).toBe(false);
		expect(events.some((e) => e.type === "tool_execution_started")).toBe(false);
		expect(calls()).toBe(0);
		expect(planAt(dir)).toEqual({ kind: "WAIT_PERMISSION", invocationSeq: callSeqOf(events) });
		expect(pause.callId).toBe("c1");

		await processDeath(it);
		live.closeAll();

		// The resume re-presents the SAME question and the human answers for
		// real; the effect happens once, after a verdict that was never given
		// about an invalid turn.
		const session2 = await reopenAgent(dir, adapter, tool, true);
		let reasked = 0;
		const events2 = await drain(session2, async (ev) => {
			reasked++;
			await session2.approve(ev.decisionId, true);
		});
		expect(terminalOf(events2)).toMatchObject({ outcome: { kind: "completed" } });
		expect(reasked).toBe(1);
		expect(calls()).toBe(1);
		expect(recordsOf(dir).filter((e) => e.type === "permission_decided")).toHaveLength(1);
	});
});

// ── F4 — the mid-stream retry's crash cells ───────────────────────────────
//
// F4 makes the loop the THIRD producer of `model_output_abandoned`: a
// retryable mid-stream cut settles the attempt, voids the draft, and
// re-requests in the same process. The durable prefixes it can leave are
// exactly the ones the resume already owns (the marker is a boundary), so
// these cells prove NO NEW AMBIGUITY: each prefix derives the one action
// the prefix table always derived for that shape.
describe("F4 — the mid-stream retry's crash cells", () => {
	it("F-T3/T4/T6b — kill during backoff, after the void, or before the exhaustion terminal: the three kill points are durably indistinguishable — CONTINUE_MODEL, exactly one marker", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-f4a-"));
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "text_delta", text: "half a draft" },
			{ seq: 2, type: "model_output_abandoned", voidFromSeq: 0, reason: "the provider stream failed before this turn committed" },
		];
		const store = new SessionStore(dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		// The marker is the last boundary and nothing follows it: the one
		// safe action is a fresh model call — the in-frame retry budget died
		// with the process (ADR-0005 Amendment 1: per-process by design).
		expect(planAt(dir)).toEqual({ kind: "CONTINUE_MODEL" });

		const { adapter } = scriptedAdapter([DONE_TURN]);
		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.resume()) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		// Exactly one marker — the resume never doubles the void.
		expect(recordsOf(dir).filter((e) => e.type === "model_output_abandoned")).toHaveLength(1);
	});

	it("F-T6a — kill between the settled receipts and the marker: the receipted read stays a fact, the draft voids, nothing re-executes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-f4b-"));
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "text_delta", text: "drafting" },
			{ seq: 2, type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } },
			{ seq: 3, type: "tool_execution_started", executionId: "ex-1", callId: "c1", name: "web_search", input: { query: "k" } },
			{ seq: 4, type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", result: { content: "read result", isError: false } },
		];
		const store = new SessionStore(dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		// A receipted execution is an OUTCOME, never uncertain (rule 3); the
		// delta suffix is a draft (rule 4) — void first, repairs follow.
		expect(planAt(dir)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 0 });

		const { adapter } = scriptedAdapter([DONE_TURN]);
		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.resume()) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		const records = recordsOf(dir);
		expect(records.filter((e) => e.type === "model_output_abandoned")).toHaveLength(1);
		// The receipt survives as audit fact; the execution NEVER re-runs.
		expect(records.filter((e) => e.type === "tool_execution_started")).toHaveLength(1);
		expect(records.filter((e) => e.type === "tool_execution_succeeded")).toHaveLength(1);
	});

	it("F-T6c — kill after the re-request began streaming: ordinary Gap B on the NEW draft, the marker is its boundary", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mx-f4c-"));
		const seed: readonly Event[] = [
			{ seq: 0, type: "user_input", content: "go" },
			{ seq: 1, type: "text_delta", text: "first draft" },
			{ seq: 2, type: "model_output_abandoned", voidFromSeq: 0, reason: "the provider stream failed before this turn committed" },
			{ seq: 3, type: "text_delta", text: "second draft" },
		];
		const store = new SessionStore(dir);
		for (const ev of seed) await store.append("s", "r1", ev);
		store.closeAll();
		// The NEW draft voids from the MARKER, not from the run's start —
		// the retry moved the boundary, and recovery agrees.
		expect(planAt(dir)).toEqual({ kind: "ABANDON_DRAFT", voidFromSeq: 2 });

		const { adapter } = scriptedAdapter([DONE_TURN]);
		const session2 = await reopenAgent(dir, adapter);
		const events: Event[] = [];
		for await (const ev of session2.resume()) events.push(ev);
		expect(terminalOf(events)).toMatchObject({ outcome: { kind: "completed" } });
		expect(recordsOf(dir).filter((e) => e.type === "model_output_abandoned")).toHaveLength(2);
	});
});
