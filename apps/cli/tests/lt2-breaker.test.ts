/**
 * LT-2 — the loop breaker, as a pure function of the event sequence.
 *
 * Two failures of one (tool, input) key abstain; the third identical attempt
 * is DENIED with the count in the reason; a success resets; a different
 * input does not count; the key ignores field order; a run's terminal
 * resets; and the extension's own hook + decide wire the same rule.
 */

import { describe, expect, it } from "vitest";
import type { Event } from "@vincemakes/kiso-core";
import { BREAKER_LIMIT, BREAKER_NAME, breakerExtension, breakerState, callKey, observe, verdict } from "../src/breaker.js";

const end = (callId: string, name: string, input: Record<string, unknown>): Event =>
	({ seq: 0, type: "tool_call_end", callId, name, input }) as unknown as Event;
const result = (callId: string, isError: boolean): Event =>
	({ seq: 0, type: "tool_result", callId, content: isError ? "boom" : "ok", isError }) as unknown as Event;
const terminal = (): Event => ({ seq: 0, type: "terminal", outcome: { kind: "completed" } }) as unknown as Event;

function fail(state: ReturnType<typeof breakerState>, n: number, name = "shell", input: Record<string, unknown> = { command: "false" }): void {
	for (let i = 0; i < n; i += 1) {
		observe(state, end(`c${i}`, name, input));
		observe(state, result(`c${i}`, true));
	}
}

describe("LT-2 — the loop breaker", () => {
	it("two identical failures abstain; the third identical attempt is denied, and the reason carries the count and the tool", () => {
		const s = breakerState();
		fail(s, 1);
		expect(verdict(s, "shell", { command: "false" })).toEqual({ action: "abstain" });
		fail(s, 1);
		const v = verdict(s, "shell", { command: "false" });
		expect(v.action).toBe("deny");
		expect((v as { reason: string }).reason).toContain("shell");
		expect((v as { reason: string }).reason).toContain("failed 2 times in a row");
		expect((v as { reason: string }).reason.startsWith(`${BREAKER_NAME}:`)).toBe(true);
		expect(BREAKER_LIMIT).toBe(3);
	});

	it("a success resets the count; a different input does not count toward the same key", () => {
		const s = breakerState();
		fail(s, 2);
		observe(s, end("ok", "shell", { command: "false" }));
		observe(s, result("ok", false));
		expect(verdict(s, "shell", { command: "false" })).toEqual({ action: "abstain" });
		fail(s, 2);
		// a different input: not the same call, so it is not refused…
		expect(verdict(s, "shell", { command: "true" })).toEqual({ action: "abstain" });
		// …and it does not extend the streak of the other key either
		fail(s, 1, "shell", { command: "true" });
		expect(verdict(s, "shell", { command: "false" })).toEqual({ action: "abstain" });
	});

	it("the key ignores field order at every depth, so a re-issued call with reordered fields is the same call", () => {
		expect(callKey("edit_file", { path: "a", search: "x", replace: "y" })).toBe(callKey("edit_file", { replace: "y", path: "a", search: "x" }));
		expect(callKey("t", { a: { y: 1, x: [1, { q: 2, p: 3 }] } })).toBe(callKey("t", { a: { x: [1, { p: 3, q: 2 }], y: 1 } }));
		expect(callKey("t", { a: 1 })).not.toBe(callKey("t", { a: 2 }));
		expect(callKey("t", { a: 1 })).not.toBe(callKey("u", { a: 1 }));
	});

	it("a run's terminal is a clean slate", () => {
		const s = breakerState();
		fail(s, 2);
		observe(s, terminal());
		expect(verdict(s, "shell", { command: "false" })).toEqual({ action: "abstain" });
	});

	it("the extension wires the same rule: the hook observes, decide refuses the third", async () => {
		const ext = breakerExtension();
		expect(ext.name).toBe(BREAKER_NAME);
		const decide = ext.approvals![0]!.decide;
		const payload = { name: "shell", input: { command: "false" } } as never;
		for (let i = 0; i < 2; i += 1) {
			expect((await decide(payload, {} as never)).action).toBe("abstain");
			await ext.hooks!.onEvent!(end(`c${i}`, "shell", { command: "false" }), {} as never);
			await ext.hooks!.onEvent!(result(`c${i}`, true), {} as never);
		}
		expect((await decide(payload, {} as never)).action).toBe("deny");
	});
});
