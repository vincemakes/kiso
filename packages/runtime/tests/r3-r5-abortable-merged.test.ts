/**
 * R3 / R5 — `abortable` settles on rejection; `MergedSignal` behaves.
 *
 * R3: `abortable` had no reject path. Its rejection handler removed the
 * listener and then THREW inside a `.then` — which creates a new rejected
 * promise nobody holds, while the outer `new Promise` executor never
 * calls resolve or reject. The outer promise never settles. It is used at
 * three sites in the recovery path, so a decision hook that rejects hangs
 * the run and leaves an unhandled rejection behind it.
 *
 * R5: `MergedSignal.addEventListener` stored a WRAPPER while
 * `removeEventListener` deleted the ORIGINAL, so removal never worked; it
 * fired once per source abort rather than once ever; `once` was not
 * honoured; and it never released its source listeners.
 *
 * Both found by an external release review and confirmed from the source
 * before any change.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineTool } from "@vincemakes/kiso-core";
import { ABORTED, MergedSignal, abortable } from "../src/recovery.js";
import { createAgent, SessionStore } from "../src/index.js";

const never = (): AbortSignal => new AbortController().signal;

describe("R3 — abortable settles when the promise rejects", () => {
	it("an ASYNC rejection settles the outer promise with that error", async () => {
		const boom = new Error("the hook said no");
		await expect(abortable(Promise.reject(boom), never())).rejects.toBe(boom);
	});

	it("a SYNC throw inside the hook settles the same way", async () => {
		const thrown = (): Promise<never> => {
			throw new Error("sync boom");
		};
		let promise: Promise<unknown>;
		try {
			promise = Promise.resolve(thrown());
		} catch (err) {
			promise = Promise.reject(err);
		}
		await expect(abortable(promise, never())).rejects.toThrow(/sync boom/);
	});

	it("a rejection AFTER an abort keeps the abort's answer and does not throw", async () => {
		const c = new AbortController();
		let reject!: (e: Error) => void;
		const pending = new Promise<string>((_, r) => {
			reject = r;
		});
		pending.catch(() => {}); // the caller's own handler; not this contract
		const result = abortable(pending, c.signal);
		c.abort();
		await expect(result).resolves.toBe(ABORTED);
		reject(new Error("late"));
		await new Promise((r) => setTimeout(r, 0));
	});

	it("an abort AFTER the promise resolved keeps the value", async () => {
		const c = new AbortController();
		const result = await abortable(Promise.resolve("decided"), c.signal);
		c.abort();
		expect(result).toBe("decided");
	});

	it("a successful decision is unchanged, and an already-aborted signal is ABORTED", async () => {
		expect(await abortable(Promise.resolve("allow"), never())).toBe("allow");
		const c = new AbortController();
		c.abort();
		expect(await abortable(Promise.resolve("allow"), c.signal)).toBe(ABORTED);
	});
});

describe("R5 — MergedSignal", () => {
	it("a REMOVED listener never fires", () => {
		const a = new AbortController();
		const merged = new MergedSignal(a.signal);
		let calls = 0;
		const listener = (): void => {
			calls += 1;
		};
		merged.addEventListener("abort", listener);
		merged.removeEventListener("abort", listener);
		a.abort();
		expect(calls, "removal must reach the same identity that was added").toBe(0);
	});

	it("a listener fires ONCE across two source aborts", () => {
		const a = new AbortController();
		const b = new AbortController();
		const merged = new MergedSignal(a.signal, b.signal);
		let calls = 0;
		merged.addEventListener("abort", () => {
			calls += 1;
		});
		a.abort();
		b.abort();
		expect(calls, "aborted is a transition, not a stream of events").toBe(1);
	});

	it("`once` is honoured", () => {
		const a = new AbortController();
		const merged = new MergedSignal(a.signal);
		let calls = 0;
		merged.addEventListener("abort", () => {
			calls += 1;
		}, { once: true });
		a.abort();
		expect(calls).toBe(1);
	});

	it("a listener added AFTER the abort does NOT fire — the standard contract", () => {
		// This gate first asserted the opposite, and the standard is right:
		// a real AbortSignal fires 'abort' on the TRANSITION, so a listener
		// added afterwards never runs. Nothing here needs the other
		// behaviour — `abortable` checks `signal.aborted` before it ever
		// adds a listener, which is the guard that covers the case. Matching
		// AbortSignal keeps this a drop-in for one.
		const a = new AbortController();
		a.abort();
		const merged = new MergedSignal(a.signal);
		expect(merged.aborted, "the STATE is readable, which is what callers use").toBe(true);
		let calls = 0;
		merged.addEventListener("abort", () => {
			calls += 1;
		});
		expect(calls).toBe(0);
	});

	it("aborted reports true when any source is aborted", () => {
		const a = new AbortController();
		const b = new AbortController();
		const merged = new MergedSignal(a.signal, b.signal);
		expect(merged.aborted).toBe(false);
		b.abort();
		expect(merged.aborted).toBe(true);
	});
});

/**
 * The whole point, through the PUBLIC API: a decision hook that rejects
 * must FAIL THE RUN with its own error — the tool never runs, there is no
 * silent allow, and nothing is left unhandled. Before the fix this call
 * never settled at all.
 *
 * Modelled on the external review's own reproduction so the gate and the
 * report describe the same run.
 */
describe("R3 — a rejecting decision hook fails the run, through session.resume()", () => {
	it("settles with the hook's error; the tool never runs; no unhandled rejection", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-r3-e2e-"));
		const root = join(dir, "home", "sessions");
		const store = new SessionStore(root);
		for (const event of [
			{ seq: 0, type: "user_input", content: "perform dummy tool" },
			{ seq: 1, type: "tool_call_end", callId: "c1", name: "dummy_tool", input: {} },
			{ seq: 2, type: "stop", reason: "tool_use" },
		]) {
			await store.append("s", "r1", event as never);
		}
		store.closeAll();

		const unhandled: string[] = [];
		const onUnhandled = (err: unknown): void => {
			unhandled.push(err instanceof Error ? err.message : String(err));
		};
		process.on("unhandledRejection", onUnhandled);
		let toolExecutions = 0;
		let hookCalls = 0;
		try {
			const agent = createAgent({
				model: "faux",
				store: new SessionStore(root),
				tools: [
					defineTool({
						name: "dummy_tool",
						description: "no side effects",
						parameters: { type: "object" },
						execute: async () => {
							toolExecutions += 1;
							return { content: "okay", isError: false };
						},
					}),
				],
				adapter: {
					// eslint-disable-next-line require-yield
					async *stream() {
						yield { type: "stop", reason: "end_turn" } as never;
					},
				} as never,
				hooks: {
					onPreTool: async () => {
						hookCalls += 1;
						throw new Error("dummy approval service unavailable");
					},
				},
			});
			const session = await agent.session({ id: "s" });
			// `resume()` hands back the RUN, and the run is the async
			// iterable — draining it is what surfaces the failure. Racing a
			// timer is how the review caught the hang, and it is kept here:
			// without it a regression would time the suite out instead of
			// naming what broke.
			const run = session.resume();
			const drain = (async () => {
				for await (const _ of run) {
					// the events themselves are not this gate's subject
				}
				return "SETTLED" as const;
			})();
			const outcome = await Promise.race([
				drain.then(
					(state) => ({ state }),
					(e: unknown) => ({ state: "REJECTED" as const, message: e instanceof Error ? e.message : String(e) }),
				),
				new Promise<{ state: "STILL_PENDING" }>((r) => setTimeout(() => r({ state: "STILL_PENDING" }), 2000)),
			]);
			expect(outcome, "the run FAILS with the hook's error rather than hanging").toMatchObject({
				state: "REJECTED",
				message: expect.stringMatching(/dummy approval service unavailable/) as unknown as string,
			});
			expect(hookCalls, "the hook was reached").toBe(1);
			expect(toolExecutions, "and the tool never ran — no silent allow").toBe(0);
			await new Promise((r) => setTimeout(r, 20));
			expect(unhandled, "nothing left unhandled behind it").toEqual([]);
			run.abort();
			agent.close();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	}, 30_000);
});
