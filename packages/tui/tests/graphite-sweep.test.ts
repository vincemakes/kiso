/**
 * Graphite, the last sweep (owner, 2026-10-06) — every command's reply on
 * the terminal in a Graphite form, with every pipe byte kept:
 *
 *   - a bracketed or ruled reply (`[no thinking yet]`, `[/compact] …`,
 *     `[reload] …`, `--- re-wrapped … ---`) is a sentence at the content
 *     edge or a meta row; a two-line reply is one row;
 *   - `/think` and `/last` bring back ONE cell: a meta row and the parts
 *     under it in their own look;
 *   - a line that is exactly a command lists that command first, so ⏎ runs
 *     it (`/skill` used to complete to `/skills`);
 *   - a pick list with nothing in it counts nothing.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cellComponent, visibleWidth, type BodyCell, type FrameCtx } from "../src/components.js";
import { Body } from "../src/compositor.js";
import { Editor } from "../src/editor.js";
import { setGround } from "../src/lines.js";
import { noticeMeta } from "../src/notice-meta.js";
import { modelPickView, pickBlockRows } from "../src/index.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const enc = (s: string): Buffer => Buffer.from(s, "utf8");
const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 24 };
beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => {
	setGround("unknown");
	vi.useRealTimers();
});

describe("a command's reply on the terminal", () => {
	it("brackets and the command's own name come off; the words stay whole at the content edge", () => {
		expect(noticeMeta("[no thinking yet]")).toEqual({ sentence: "no thinking yet" });
		expect(noticeMeta("[nothing to copy — no answer yet]")).toEqual({ sentence: "nothing to copy — no answer yet" });
		expect(noticeMeta("[/compact] nothing to compact — fewer than 5 rounds yet")).toEqual({ sentence: "nothing to compact — fewer than 5 rounds yet" });
		expect(noticeMeta("[/rewrap] no prose to re-wrap yet")).toEqual({ sentence: "no prose to re-wrap yet" });
		expect(noticeMeta("[/clear] a run is in flight — let it finish (esc stops it), then clear")).toEqual({ sentence: "a run is in flight — let it finish (esc stops it), then clear" });
		// a failure keeps what failed
		expect(noticeMeta("[/model] failed: no such route")).toEqual({ sentence: "/model failed: no such route" });
		expect(noticeMeta("[reload] 4 extensions, 0 skills — the conversation is unchanged")).toEqual({ sentence: "reloaded 4 extensions, 0 skills — the conversation is unchanged" });
		expect(noticeMeta("[reload] EACCES — nothing changed, the previous set is still in force")).toEqual({ sentence: "reload failed: EACCES — nothing changed, the previous set is still in force" });
		expect(noticeMeta("[turn held — the interrupted execution is still undecided] go on")).toEqual({ sentence: "turn held — the interrupted execution is still undecided · go on" });
	});

	it("a two-line reply is one row; a session switch and a re-wrap are session events", () => {
		expect(noticeMeta("no such mode: bogus\ntiers: default accept-edits plan full-access")).toEqual({ sentence: "no such mode: bogus · tiers: default accept-edits plan full-access" });
		expect(noticeMeta("session 2026-10-06T12-20-36-94eb (switched — previous: sweep-a, /resume sweep-a returns)\n")).toEqual({ label: "SESSION", sentence: "2026-10-06T12-20-36-94eb · /resume sweep-a returns" });
		expect(noticeMeta("--- re-wrapped 3 blocks at the current width (appended — the history above is unchanged) ---")).toEqual({ label: "REWRAPPED", sentence: "3 blocks at the current width · the history above is unchanged" });
		expect(noticeMeta("--- 2 earlier blocks not re-wrapped (bounded at two screens) ---")).toEqual({ sentence: "2 earlier blocks not re-wrapped — bounded at two screens" });
		expect(noticeMeta("[dontAsk] the model's question was declined — nothing asks in dontAsk")).toEqual({ label: "DENIED", sentence: "the model's question — nothing asks while don't ask is on" });
	});

	it("the shapes that were already there win first", () => {
		expect(noticeMeta("[/compact] ✦ compacted · 12k → 3k")).toEqual({ label: "COMPACTED", sentence: "12k → 3k" });
		expect(noticeMeta("[dontAsk] shell would ask — denied")).toEqual({ label: "DENIED", sentence: "shell would ask — denied" });
		expect(noticeMeta("[dontAsk] 2 uncertain executions left unresolved — resolve them in an asking mode")).toMatchObject({ label: "UNCERTAIN" });
		// a sentence with no shape is untouched
		expect(noticeMeta("copied 48 chars")).toEqual({ sentence: "copied 48 chars" });
	});

	it("on a dock the reply sits at the content edge without its brackets; a pipe keeps every byte", () => {
		for (const active of [true, false]) {
			const writes: string[] = [];
			const body = new Body({ active: () => active, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
			if (active) body.enter();
			vi.useFakeTimers();
			body.notice("[no thinking yet]");
			body.notice("no such mode: bogus\ntiers: default plan");
			vi.advanceTimersByTime(50);
			vi.useRealTimers();
			const out = plain(writes.join(""));
			if (active) {
				expect(out).toContain("  no thinking yet");
				expect(out).not.toContain("[no thinking yet]");
				expect(out).toContain("  no such mode: bogus · tiers: default plan");
			} else {
				expect(writes.join("")).toBe("[no thinking yet]\nno such mode: bogus\ntiers: default plan\n");
			}
		}
	});
});

const recall = (over: Partial<Extract<BodyCell, { kind: "recall" }>> = {}): BodyCell => ({
	kind: "recall",
	text: "pipe text",
	label: "LAST CALL",
	sentence: "LIST (root) · 2 lines",
	sections: [
		{ title: "input", text: "{}", style: "output" },
		{ title: "output", text: "dir  .git/\ndir  src/", style: "output" },
	],
	done: true,
	...over,
});

describe("/think and /last bring back one cell", () => {
	it("LAST CALL: the meta row, then the input and the output under dim titles, hung by two", () => {
		setGround("light");
		const rows = cellComponent(recall()).render(100, CTX).map((r) => plain(r).trimEnd());
		expect(rows).toEqual(["  LAST CALL   LIST (root) · 2 lines", "  input", "    {}", "  output", "    dir  .git/", "    dir  src/"]);
	});

	it("THINKING: the meta row, then the block as thinking draws it — grey italic at the content edge", () => {
		setGround("dark");
		const rows = cellComponent(recall({ label: "THINKING", sentence: "the last block · 1 line", sections: [{ text: "Let me think about the workspace.", style: "thinking" }] })).render(100, CTX);
		expect(rows.map((r) => plain(r).trimEnd())).toEqual(["  THINKING    the last block · 1 line", "  Let me think about the workspace."]);
		expect(rows[1]).toContain("\x1b[3m"); // italic
	});

	it("an output's colours and escapes never reach the terminal; long rows fold inside the width", () => {
		setGround("light");
		const long = `${"x".repeat(150)}\n\x1b[31mred\x1b[39m \x1b]0;title\x07done`;
		for (const W of [20, 40, 80, 140]) {
			const rows = cellComponent(recall({ sections: [{ title: "output", text: long, style: "output" }] })).render(W, CTX);
			for (const r of rows) expect(visibleWidth(r), `W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
			const text = rows.map(plain).join("\n");
			expect(text).toContain("red done");
			expect(text).not.toContain("title");
		}
	});

	it("on a dock it is one cell; a pipe prints the text it was given, byte for byte", () => {
		for (const active of [true, false]) {
			const writes: string[] = [];
			const body = new Body({ active: () => active, height: () => 24, width: () => 80, editCol: () => 1, write: (s) => writes.push(s) });
			if (active) body.enter();
			vi.useFakeTimers();
			body.recall("--- list_dir input ---\n{}\n--- list_dir output ---\ndir  src/", "LAST CALL", "LIST (root) · 1 line", [
				{ title: "input", text: "{}", style: "output" },
				{ title: "output", text: "dir  src/", style: "output" },
			]);
			vi.advanceTimersByTime(50);
			vi.useRealTimers();
			const out = plain(writes.join(""));
			if (active) {
				expect(out).not.toContain("--- list_dir");
				// one cell: the parts on consecutive rows, no blank row between
				const rows = out.split(/\x1b\[\d+;1H\x1b\[0K/).map((r) => r.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trimEnd());
				const at = rows.findIndex((r) => r.includes("LAST CALL"));
				expect(rows.slice(at, at + 5)).toEqual(["  LAST CALL   LIST (root) · 1 line", "  input", "    {}", "  output", "    dir  src/"]);
			} else {
				expect(writes.join("")).toBe("--- list_dir input ---\n{}\n--- list_dir output ---\ndir  src/\n");
			}
		}
	});
});

describe("the slash menu: a command typed in full", () => {
	it("is listed first, so ⏎ runs it rather than completing to a longer name", () => {
		const editor = new Editor(() => {});
		const submitted: string[] = [];
		editor.onLine((l) => submitted.push(l));
		editor.feed(enc("/skill"));
		expect(editor.menuState()?.items.map((m) => m.name)).toEqual(["/skill", "/skills"]);
		editor.feed(enc("\r"));
		expect(submitted).toEqual(["/skill"]);
	});

	it("a prefix keeps the table's order", () => {
		const editor = new Editor(() => {});
		editor.feed(enc("/ski"));
		expect(editor.menuState()?.items.map((m) => m.name)).toEqual(["/skills", "/skill"]);
	});
});

describe("a pick list with nothing in it", () => {
	it("counts nothing; a filter that matches nothing still counts 0/0", () => {
		setGround("light");
		const view = (options: readonly { label: string }[]) => modelPickView({ header: "model", noun: "profiles", input: "filter", options, emptyNote: "no profiles — define models in ~/.kiso/config.json" } as never, "");
		const empty = pickBlockRows(view([]), { cursor: 0, level: null, query: "" }, 80, 8).map(plain);
		expect(empty.join("\n")).toContain("no profiles");
		expect(empty.join("\n")).not.toContain("0/0");
		expect(empty.at(-1)?.trim()).toBe("esc");
		const none = pickBlockRows(view([{ label: "ds" }]), { cursor: 0, level: null, query: "zz" }, 80, 8).map(plain);
		expect(none.join("\n")).toContain('nothing matches "zz"');
		expect(none.at(-1)?.trim()).toMatch(/^esc +0\/0$/);
	});
});
