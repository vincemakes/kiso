/**
 * E1 §3 — COPY THE LAST ANSWER.
 *
 * `ctrl+x` and `/copy` put the model's most recent complete answer on
 * the clipboard as RAW MARKDOWN.
 *
 * Three things this file pins, each of which was a ruling rather than a
 * default:
 *
 * 1. **The source is the durable log's projection**, never the rendered
 *    rows and never a join of the trailing `text_delta` frames. The
 *    rendered form is folded, washed and cut, and none of that belongs
 *    in a paste; the delta frames are a live projection, not a record.
 *    A message a retry or an abort VOIDED is not an answer — the session
 *    decided it did not happen, and handing the user text the transcript
 *    disowns would be a lie about what was said.
 *
 * 2. **The status row says which of two things happened, and never
 *    more.** On darwin `pbcopy` reports an exit status, so `copied N
 *    chars` is a claim we can support. Everywhere else the route is
 *    OSC 52, which is a REQUEST to the terminal: most terminals do not
 *    answer and Apple Terminal does not implement it at all. So the row
 *    says `asked the terminal to copy N chars`. An earlier draft said
 *    `copied N chars (via the terminal)`, which still leads with the
 *    word "copied"; it was replaced for that reason.
 *
 * 3. **A non-TTY stdout emits NO sequence at all.** Writing an OSC into
 *    a pipe puts escape bytes in someone's data.
 */

import { describe, expect, it } from "vitest";
import { clipboardWrite, lastAnswer } from "../src/clipboard.js";
import type { Message } from "@vincemakes/kiso-core";

const assistant = (text: string): Message => ({ role: "assistant", blocks: [{ type: "text", text }] }) as Message;
const user = (text: string): Message => ({ role: "user", content: text }) as Message;

describe("E1 §3 — which answer gets copied", () => {
	it("the LAST assistant message, verbatim", () => {
		expect(lastAnswer([user("a"), assistant("first"), user("b"), assistant("second")])).toBe("second");
	});

	it("RAW markdown — the copy is the source, not the render", () => {
		const md = "# heading\n\n- a list item\n\n```ts\nconst x = 1;\n```";
		expect(lastAnswer([assistant(md)])).toBe(md);
	});

	it("a tool-result message is not an answer", () => {
		const tool = { role: "tool_result", callId: "c1", content: "out" } as unknown as Message;
		expect(lastAnswer([assistant("the answer"), tool])).toBe("the answer");
	});

	it("no assistant message yet: null, so the caller can say so", () => {
		expect(lastAnswer([user("hello")])).toBeNull();
	});

	it("an assistant message with no text blocks is not an answer", () => {
		// a turn that only called tools said nothing to copy
		const toolsOnly = { role: "assistant", blocks: [{ type: "tool_use", callId: "c1", name: "shell", input: {} }] } as unknown as Message;
		expect(lastAnswer([assistant("real answer"), toolsOnly])).toBe("real answer");
	});

	it("several text blocks in one message join with a blank line", () => {
		const m = { role: "assistant", blocks: [{ type: "text", text: "one" }, { type: "text", text: "two" }] } as unknown as Message;
		expect(lastAnswer([m])).toBe("one\n\ntwo");
	});
});

describe("E1 §3 — the route, and what the status row may claim", () => {
	const calls: { cmd: string; args: readonly string[]; stdin: string | undefined }[] = [];
	const runner = (cmd: string, args: readonly string[], stdin?: string) => {
		calls.push({ cmd, args, stdin });
		return { status: 0 };
	};

	it("darwin: pbcopy, and the row may say `copied`", () => {
		calls.length = 0;
		const r = clipboardWrite("hello", { platform: "darwin", isTTY: true, run: runner, write: () => {} });
		expect(calls[0]?.cmd).toBe("pbcopy");
		expect(calls[0]?.stdin).toBe("hello");
		expect(r.message).toBe("copied 5 chars");
	});

	it("darwin, pbcopy FAILS: the row does not claim it worked", () => {
		const r = clipboardWrite("hello", {
			platform: "darwin",
			isTTY: true,
			run: () => ({ status: 1 }),
			write: () => {},
		});
		expect(r.message).not.toContain("copied 5 chars");
		expect(r.message.toLowerCase()).toContain("could not");
	});

	it("elsewhere: OSC 52, and the row says ASKED — never `copied`", () => {
		let written = "";
		const r = clipboardWrite("hello", { platform: "linux", isTTY: true, run: runner, write: (s) => { written += s; } });
		expect(written.startsWith("\x1b]52;c;")).toBe(true);
		expect(written).toContain(Buffer.from("hello", "utf8").toString("base64"));
		expect(r.message).toBe("asked the terminal to copy 5 chars");
		// the word `copied` would be a claim the route cannot support
		expect(r.message.startsWith("copied")).toBe(false);
	});

	it("stdout is NOT a TTY: no sequence at all, and it says so", () => {
		let written = "";
		const r = clipboardWrite("hello", { platform: "linux", isTTY: false, run: runner, write: (s) => { written += s; } });
		expect(written).toBe("");
		expect(r.message).toBe("no terminal to copy to");
	});

	it("darwin without a TTY does NOT copy — a pipe may not touch the desktop", () => {
		// Written the other way round first ("pbcopy is a process, not a
		// terminal route, so it works with stdout redirected"). It does
		// work, and that is the objection: `kiso chat < input.txt` in a
		// script would silently overwrite whatever the human had on their
		// clipboard. The TTY test therefore runs BEFORE the platform test.
		calls.length = 0;
		const r = clipboardWrite("hello", { platform: "darwin", isTTY: false, run: runner, write: () => {} });
		expect(calls).toEqual([]);
		expect(r.message).toBe("no terminal to copy to");
	});
});
