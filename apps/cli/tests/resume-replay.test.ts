/**
 * 4c — the resumed session replayed into cells (the pure projection).
 *
 * A recording Body double: the replay is judged by the CALLS it makes —
 * the same mutations a live run makes — and by what it folds.
 */

import { describe, expect, it } from "vitest";
import { replayInto, type ReplayBody } from "../src/replay.js";

type Call = string;

function recorder(): { body: ReplayBody; calls: Call[] } {
	const calls: Call[] = [];
	const body: ReplayBody = {
		userLine: (t) => calls.push(`user ${t}`),
		thinkingAppend: (t) => calls.push(`think ${t}`),
		thinkingEnd: () => calls.push("think-end"),
		textAppend: (t) => calls.push(`text ${t}`),
		textEnd: () => calls.push("text-end"),
		toolStart: (n, id) => calls.push(`tool ${n} ${id}`),
		toolResult: (id, r) => calls.push(`result ${id} ${r.isError ? "err" : "ok"}${r.untimed === true ? " untimed" : ""}${r.reason ? ` (${r.reason})` : ""}`),
		notice: (t) => calls.push(`notice ${t}`),
		// the tasks round: a task notice records its pipe text, as notice did
		metaNotice: (t) => calls.push(`notice ${t}`),
		endTurn: () => calls.push("end-turn"),
		fold: (label, replay, summary) => {
			calls.push(`fold[ ${label}${summary ? ` | ${summary}` : ""}`);
			replay();
			calls.push("]fold");
		},
		raw: (lines) => calls.push(`raw ${lines.join("/")}`),
	};
	return { body, calls };
}

let seq = 0;
const ev = (e: { type: string } & Record<string, unknown>) => ({ ...e, seq: seq++ });
const turn = (ask: string, reply: string) => [ev({ type: "user_input", content: ask }), ev({ type: "text_delta", text: reply }), ev({ type: "text_end" }), ev({ type: "terminal", outcome: { kind: "completed" } })];

describe("4c — replayInto", () => {
	it("three turns: the first folds into ONE row that names the viewer's key; the last two replay in full", () => {
		seq = 0;
		const { body, calls } = recorder();
		const n = replayInto(body, [...turn("first ask", "first reply"), ...turn("second ask", "second reply"), ...turn("third ask", "third reply")], 60);
		expect(n).toBe(3);
		expect(calls[0]).toMatch(/^raw ─── resuming · 3 turns, showing the last 2 ─+$/);
		expect(calls.slice(1)).toEqual([
			"fold[ 1 earlier turn · ctrl+r to read",
			"user first ask",
			"text first reply",
			"text-end",
			"text-end",
			"end-turn",
			"]fold",
			"user second ask",
			"text second reply",
			"text-end",
			"text-end",
			"end-turn",
			"user third ask",
			"text third reply",
			"text-end",
			"text-end",
			"end-turn",
		]);
	});

	it("two turns or fewer: no fold at all", () => {
		seq = 0;
		const { body, calls } = recorder();
		replayInto(body, [...turn("a", "b"), ...turn("c", "d")]);
		expect(calls.some((c) => c.startsWith("fold"))).toBe(false);
		expect(calls[0]).toMatch(/resuming · 2 turns /);
	});

	it("tools settle untimed, a denial keeps its reason, thinking closes before what follows", () => {
		seq = 0;
		const { body, calls } = recorder();
		replayInto(body, [
			ev({ type: "user_input", content: "go" }),
			ev({ type: "thinking", text: "hmm" }),
			ev({ type: "tool_call_end", name: "read_file", callId: "c1", input: { path: "a.ts" } }),
			ev({ type: "tool_result", callId: "c1", content: "x", isError: false }),
			ev({ type: "tool_call_end", name: "shell", callId: "c2", input: { command: "rm -rf build" } }),
			ev({ type: "tool_result", callId: "c2", content: "[Permission denied] not now", isError: true, tags: ["denied"] }),
		]);
		expect(calls.slice(1)).toEqual([
			"user go",
			"think hmm",
			"think-end",
			"tool read_file c1",
			"result c1 ok untimed",
			"tool shell c2",
			"result c2 err untimed (not now)",
			"text-end",
			"end-turn",
		]);
	});

	it("a skill turn replays as the line the person typed; a system input is machinery inside the turn, never a new turn", () => {
		seq = 0;
		const { body, calls } = recorder();
		replayInto(body, [
			ev({ type: "user_input", content: "the SKILL.md body", via: { skill: "boss-call", line: "/boss-call hi" } }),
			ev({ type: "text_delta", text: "done" }),
			ev({ type: "user_input", content: "check it", source: "system" }),
		]);
		expect(calls[0]).toMatch(/resuming · 1 turn /);
		expect(calls).toContain("user /boss-call hi");
		expect(calls).not.toContain("user the SKILL.md body");
		expect(calls).toContain("notice verification pass");
	});

	it("0.44.0: an old log's task_set call replays as an ordinary tool row, exactly like any other tool", () => {
		// The task extension is retired, but logs written while it was
		// loaded still carry its calls, with the tagged echo it wrote. The
		// replay neither drops them nor treats them specially: the same log
		// under any other tool name replays to the same calls.
		const log = (name: string) => {
			seq = 0;
			return [
				ev({ type: "user_input", content: "plan it" }),
				ev({ type: "tool_call_end", callId: "t1", name, input: { items: [{ text: "step one", status: "active" }] } }),
				ev({
					type: "tool_result",
					callId: "t1",
					content: "[task] 1 item — 0 pending, 1 active, 0 done\n[active] step one",
					isError: false,
					tags: ["do-not-compact"],
				}),
				ev({ type: "text_delta", text: "on it" }),
				ev({ type: "text_end" }),
				ev({ type: "terminal", outcome: { kind: "completed" } }),
			];
		};
		const old = recorder();
		replayInto(old.body, log("task_set"));
		const plain = recorder();
		replayInto(plain.body, log("read_file"));
		expect(old.calls).toContain("tool task_set t1");
		expect(old.calls).toContain("result t1 ok untimed");
		expect(old.calls.map((c) => c.replace("task_set", "read_file"))).toEqual(plain.calls);
	});

	it("an interrupted turn says so instead of a blank", () => {
		seq = 0;
		const { body, calls } = recorder();
		replayInto(body, [ev({ type: "user_input", content: "go" })]);
		expect(calls).toContain("notice no reply recorded — this is where it stopped");
	});

	it("a compaction: the checkpoint folds the turns it covers with its summary, in place of the plain fold", () => {
		seq = 0;
		const { body, calls } = recorder();
		const covered = [...turn("one", "r1"), ...turn("two", "r2")];
		const boundary = covered[covered.length - 1]!.seq;
		replayInto(body, [...covered, ev({ type: "summarized", coversToSeq: boundary, summary: "we set up the repo" }), ...turn("three", "r3"), ...turn("four", "r4")]);
		const folds = calls.filter((c) => c.startsWith("fold["));
		expect(folds).toEqual(["fold[ checkpoint · summarizes 2 earlier turns · ctrl+r to read | we set up the repo"]);
		expect(calls[0]).toMatch(/resuming · 4 turns, showing the last 2/);
		const open = calls.indexOf(folds[0]!);
		expect(calls.slice(open + 1, calls.indexOf("]fold"))).toContain("user one");
		expect(calls.slice(calls.indexOf("]fold"))).toContain("user three");
	});

	it("a compaction with more than two uncovered turns: the checkpoint, then the uncovered earlier turns folded, then two in full", () => {
		seq = 0;
		const { body, calls } = recorder();
		const covered = turn("one", "r1");
		const boundary = covered[covered.length - 1]!.seq;
		replayInto(body, [...covered, ev({ type: "summarized", coversToSeq: boundary, summary: "s" }), ...turn("two", "r2"), ...turn("three", "r3"), ...turn("four", "r4")]);
		expect(calls.filter((c) => c.startsWith("fold["))).toEqual(["fold[ checkpoint · summarizes 1 earlier turn · ctrl+r to read | s", "fold[ 1 earlier turn · ctrl+r to read"]);
	});

	it("a fresh session draws nothing", () => {
		const { body, calls } = recorder();
		expect(replayInto(body, [])).toBe(0);
		expect(calls).toEqual([]);
	});
});
