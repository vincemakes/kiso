/**
 * ADR-0057 — Safe Admission, the kernel half.
 *
 * New input may ARRIVE at any time; the kernel ADMITS it — appends it as a
 * `user_input` — only at a quiescent boundary of a run that may still ask
 * the model:
 *
 *   site A  the turn head, after the abort check, only while
 *           turns < maxTurns, BEFORE the END_TURN scan;
 *   site B  a turn with no tool calls, before its terminal (take or seal);
 *   site C  after request-mode compaction, before onPreLlm.
 *
 * Every terminal seals the ingress first. A human input passes
 * onUserMessage once (a veto drops it and the run goes on); a runtime input
 * never does. No `admit`, or an `admit` that returns nothing, changes no
 * request byte.
 *
 * The ingress here is a stand-in for the runtime's: input "arrives" when a
 * test says so and is handed over at the next site that asks.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Adapter } from "../src/protocol/adapter.js";
import type { Event, UserInputVia } from "../src/protocol/events.js";
import type { Message } from "../src/protocol/messages.js";
import type { PermissionDecision } from "../src/kernel/permission.js";
import { EventLog, loop, type AdmissionInput, type LoopConfig } from "../src/index.js";
import { END_TURN } from "../src/kernel/project.js";
import { defineTool } from "../src/tools/tool.js";
import { ToolRegistry } from "../src/tools/registry.js";

const TOOL_TURN = { events: [{ type: "tool_call_end" as const, callId: "c1", name: "work", input: {} }, { type: "stop" as const, reason: "tool_use" as const }] };
const END = (text = "done") => ({ events: [{ type: "text_delta" as const, text }, { type: "stop" as const, reason: "end_turn" as const }] });

/** A faux provider that remembers every request's messages; `onStream`
 *  runs as each request starts (the model is "writing"). */
function recording(script: FauxScript, onStream?: (n: number) => void): { adapter: Adapter; requests: Message[][] } {
	const faux = createFauxProvider(script);
	const requests: Message[][] = [];
	return {
		requests,
		adapter: {
			stream(options) {
				requests.push([...options.messages]);
				onStream?.(requests.length);
				return faux.stream(options);
			},
		},
	};
}

/** The stand-in ingress: arrived input is handed over at the next site that
 *  asks; every mode asked is recorded. */
function ingress() {
	const modes: string[] = [];
	const pending: AdmissionInput[] = [];
	let sealed = false;
	return {
		modes,
		sealed: () => sealed,
		arrive(input: AdmissionInput) {
			pending.push(input);
		},
		admit: async (mode: "take" | "takeOrSeal" | "seal"): Promise<readonly AdmissionInput[]> => {
			modes.push(mode);
			if (mode !== "seal" && pending.length > 0) return pending.splice(0);
			if (mode !== "take") sealed = true;
			return [];
		},
	};
}

const steer = (text: string): AdmissionInput => ({ kind: "human", content: text });

function registryWith(onRun: () => void | Promise<void>, tags?: readonly string[]): ToolRegistry {
	const registry = new ToolRegistry();
	registry.register(
		defineTool({
			name: "work",
			description: "W",
			parameters: { type: "object" },
			execute: async () => {
				await onRun();
				return { content: "worked", isError: false, ...(tags !== undefined ? { tags } : {}) };
			},
		}),
	);
	return registry;
}

async function drive(config: Partial<LoopConfig> & Pick<LoopConfig, "adapter" | "registry">): Promise<Event[]> {
	const events: Event[] = [];
	for await (const ev of loop({ model: "faux", log: new EventLog(), messages: [{ role: "user", content: "go" }], ...config })) events.push(ev);
	return events;
}

const lastText = (messages: readonly Message[]): string | undefined => {
	const last = messages.at(-1);
	if (last?.role !== "user") return undefined;
	return typeof last.content === "string" ? last.content : last.content.map((b) => (b.type === "text" ? b.text : "")).join("|");
};
const seqOf = (events: readonly Event[], type: Event["type"], pick: (e: Event) => boolean = () => true): number =>
	events.find((e) => e.type === type && pick(e))!.seq;
const inputs = (events: readonly Event[]) => events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input");
const terminals = (events: readonly Event[]) => events.filter((e) => e.type === "terminal");

describe("ADR-0057 — admission waits for quiescence", () => {
	it("a steer that arrives while an effect executes is admitted after its receipt, into the same run", async () => {
		const src = ingress();
		const { adapter, requests } = recording([TOOL_TURN, END()]);
		const events = await drive({ adapter, registry: registryWith(() => src.arrive(steer("only the editor tests"))), admit: src.admit });
		const steerSeq = seqOf(events, "user_input", (e) => (e as Event & { type: "user_input" }).content === "only the editor tests");
		expect(steerSeq).toBeGreaterThan(seqOf(events, "tool_result"));
		expect(steerSeq).toBeGreaterThan(seqOf(events, "tool_execution_succeeded"));
		expect(requests).toHaveLength(2);
		expect(lastText(requests[1]!)).toBe("only the editor tests");
		expect(terminals(events)).toHaveLength(1);
	});

	it("a steer that arrives while an approval is open waits for the decision", async () => {
		const src = ingress();
		let asking = false;
		const takenWhileAsking: boolean[] = [];
		const admit = async (mode: "take" | "takeOrSeal" | "seal") => {
			const got = await src.admit(mode);
			if (got.length > 0) takenWhileAsking.push(asking);
			return got;
		};
		const { adapter, requests } = recording([TOOL_TURN, END()]);
		const events = await drive({
			adapter,
			registry: registryWith(() => {}),
			admit,
			hooks: { onPreTool: async (): Promise<PermissionDecision> => ({ action: "defer" }) },
			resolveApproval: async (): Promise<PermissionDecision> => {
				asking = true;
				src.arrive(steer("do not touch package.json"));
				await new Promise((r) => setTimeout(r, 5));
				asking = false;
				return { action: "allow" };
			},
		});
		expect(takenWhileAsking).toEqual([false]);
		expect(seqOf(events, "user_input", (e) => (e as Event & { type: "user_input" }).content === "do not touch package.json")).toBeGreaterThan(seqOf(events, "tool_result"));
		expect(lastText(requests[1]!)).toBe("do not touch package.json");
	});
});

describe("ADR-0057 — the three sites", () => {
	it("site A beats END_TURN: a pending steer keeps the run going after an END_TURN result", async () => {
		const src = ingress();
		const { adapter, requests } = recording([TOOL_TURN, END()]);
		const events = await drive({ adapter, registry: registryWith(() => src.arrive(steer("one more thing")), [END_TURN]), admit: src.admit });
		expect(requests).toHaveLength(2);
		expect(lastText(requests[1]!)).toBe("one more thing");
		expect(terminals(events)).toHaveLength(1);
	});

	it("site B: a steer sent while the model writes its final answer continues the same run", async () => {
		const src = ingress();
		const { adapter, requests } = recording([END("first"), END("second")], (n) => {
			if (n === 1) src.arrive(steer("and add a test"));
		});
		const events = await drive({ adapter, registry: new ToolRegistry(), admit: src.admit });
		expect(requests).toHaveLength(2);
		expect(lastText(requests[1]!)).toBe("and add a test");
		expect(terminals(events)).toHaveLength(1);
		// B takes; the next B finds nothing and seals; the terminal seals again.
		expect(src.modes.filter((m) => m !== "take")).toEqual(["takeOrSeal", "takeOrSeal", "seal"]);
	});

	it("site C: a steer that arrives during request-mode compaction reaches the very next request", async () => {
		const src = ingress();
		let first = true;
		const { adapter, requests } = recording([END()]);
		await drive({
			adapter,
			registry: new ToolRegistry(),
			admit: src.admit,
			compact: async (_events, _messages, why) => {
				if (why === "request" && first) {
					first = false;
					src.arrive(steer("while you were summarising"));
				}
				return [];
			},
		});
		expect(lastText(requests[0]!)).toBe("while you were summarising");
	});

	it("overflow compaction does not admit: the retry goes out without the steer, and it lands after", async () => {
		const src = ingress();
		const overflowTurn = { events: [{ type: "fail" as const, code: "context_overflow", status: 400, retryable: false, message: "maximum context length is 1000 tokens" }] };
		const { adapter, requests } = recording([overflowTurn, END("retried"), END("answered")]);
		await drive({
			adapter,
			registry: new ToolRegistry(),
			admit: src.admit,
			compact: async (_events, _messages, why) => {
				if (why !== "overflow") return [];
				src.arrive(steer("arrived during the overflow"));
				return [{ type: "microcompacted", beforeSeq: 0 }];
			},
		});
		expect(requests).toHaveLength(3);
		expect(lastText(requests[1]!)).not.toBe("arrived during the overflow");
		expect(lastText(requests[2]!)).toBe("arrived during the overflow");
	});
});

describe("ADR-0057 — sealing and eligibility", () => {
	it("every terminal seals the ingress before onStop runs", async () => {
		const order: string[] = [];
		const src = ingress();
		const admit = async (mode: "take" | "takeOrSeal" | "seal") => {
			order.push(mode);
			return src.admit(mode);
		};
		const { adapter } = recording([END()]);
		await drive({ adapter, registry: new ToolRegistry(), admit, hooks: { onStop: async () => void order.push("onStop") } });
		expect(order.slice(-2)).toEqual(["seal", "onStop"]);
		expect(src.sealed()).toBe(true);
	});

	it("maxTurns wins: input pending at the limit is never admitted", async () => {
		const src = ingress();
		const { adapter, requests } = recording([TOOL_TURN, END()]);
		const events = await drive({ adapter, registry: registryWith(() => src.arrive(steer("too late"))), admit: src.admit, maxTurns: 1 });
		expect(requests).toHaveLength(1);
		expect(inputs(events).map((e) => e.content)).not.toContain("too late");
		expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "max_turns" } });
		expect(src.modes.at(-1)).toBe("seal");
	});
});

describe("ADR-0057 — the hook: human input once, runtime input never", () => {
	it("a batch of three lines is ONE user_input with three blocks and ONE hook call", async () => {
		const src = ingress();
		const hooked: unknown[] = [];
		const { adapter } = recording([TOOL_TURN, END()]);
		const events = await drive({
			adapter,
			registry: registryWith(() =>
				src.arrive({ kind: "human", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" }] }),
			),
			admit: src.admit,
			hooks: {
				onUserMessage: async (msg) => {
					hooked.push(msg.content);
					return msg;
				},
			},
		});
		const admitted = inputs(events).at(-1)!;
		expect(admitted.content).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }, { type: "text", text: "c" }]);
		expect(hooked).toHaveLength(2); // the run's own input, then the batch
	});

	it("a vetoed steer is dropped and the run goes on — the next request is the one without it", async () => {
		const src = ingress();
		const { adapter, requests } = recording([TOOL_TURN, END()]);
		const events = await drive({
			adapter,
			registry: registryWith(() => src.arrive(steer("forbidden"))),
			admit: src.admit,
			hooks: { onUserMessage: async (msg) => (msg.content === "forbidden" ? null : msg) },
		});
		const replaced = events.filter((e): e is Event & { type: "user_input_replaced" } => e.type === "user_input_replaced");
		expect(replaced.at(-1)?.content).toBeNull();
		expect(requests).toHaveLength(2);
		expect(requests[1]!.at(-1)?.role).toBe("tool");
		expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});

	it("a runtime input skips onUserMessage; a human input beside it is still vetoed", async () => {
		const src = ingress();
		const { adapter, requests } = recording([TOOL_TURN, END()]);
		const events = await drive({
			adapter,
			registry: registryWith(() => {
				src.arrive({ kind: "runtime", content: "task t1 exited 0", source: "system" });
				src.arrive(steer("vetoed"));
			}),
			admit: src.admit,
			hooks: { onUserMessage: async (msg) => (msg.content === "go" ? msg : null) },
		});
		const runtimeInput = inputs(events).find((e) => e.content === "task t1 exited 0")!;
		expect(runtimeInput.source).toBe("system");
		const replaced = events.filter((e): e is Event & { type: "user_input_replaced" } => e.type === "user_input_replaced");
		expect(replaced.map((r) => r.replaces)).not.toContain(runtimeInput.seq);
		const texts = requests[1]!.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : ""));
		expect(texts).toContain("task t1 exited 0");
		expect(texts).not.toContain("vetoed");
	});

	it("on resume, a vetoed input that was admitted mid-run drops the input, not the run", async () => {
		// the durable prefix of a crash between an admitted steer and its hook's replacement
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "user_input_replaced", replaces: 0, content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "work", input: {} });
		log.append({ type: "stop", reason: "tool_use" });
		log.append({ type: "tool_result", callId: "c1", content: "worked", isError: false });
		log.append({ type: "user_input", content: "forbidden" });
		const { adapter, requests } = recording([END()]);
		const events: Event[] = [];
		for await (const ev of loop({ adapter, model: "faux", registry: registryWith(() => {}), log, hooks: { onUserMessage: async (msg) => (msg.content === "forbidden" ? null : msg) } })) events.push(ev);
		expect(requests).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
	});
});

describe("ADR-0058 (3c) — a wake run's first input is the runtime's, never the person's hook's", () => {
	it("a fresh run whose initial input is a task notice never passes it through onUserMessage; a person's input still does", async () => {
		const run = async (via?: UserInputVia) => {
			const log = new EventLog();
			log.append({ type: "user_input", content: "t1 exited", source: via !== undefined ? "system" : "user", ...(via !== undefined ? { via } : {}) });
			let calls = 0;
			const { adapter } = recording([END()]);
			for await (const _ev of loop({ adapter, model: "faux", registry: registryWith(() => {}), log, hooks: { onUserMessage: async (msg) => ((calls += 1), null) } })) {
				// drain
			}
			return calls;
		};
		expect(await run({ kind: "tasks", items: [{ taskId: "t1", transition: "exited" }] })).toBe(0);
		expect(await run()).toBe(1);
	});
});

describe("ADR-0057 — nothing admitted, nothing changed", () => {
	it("no admit, and an admit that returns nothing, send byte-identical requests", async () => {
		const bytes = async (admit?: LoopConfig["admit"]) => {
			const { adapter, requests } = recording([TOOL_TURN, END()]);
			const events = await drive({ adapter, registry: registryWith(() => {}), ...(admit !== undefined ? { admit } : {}) });
			return { requests: JSON.stringify(requests), types: events.map((e) => e.type).join(",") };
		};
		const none = await bytes();
		const empty = await bytes(async () => []);
		expect(empty).toEqual(none);
	});
});
