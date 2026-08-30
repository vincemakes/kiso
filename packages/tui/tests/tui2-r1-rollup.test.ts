/**
 * TUI2-R1 slice ③ — T-V2: B, the exploration rollup.
 *
 * DECLARED SUPERSESSION (R3b, owner ruling 2026-08-27) — WHERE the
 * rollup appears has moved; WHAT it says has not.
 *
 * The segment fold now collapses a whole run of work into one line the
 * moment the model speaks, so a closed run's COMMITTED form is
 * `✦ thought Ns · 5 reads · ctrl+r`, not the exploration row. The
 * exploration row is what `ctrl+r` opens — the owner chose to keep it
 * precisely because it says more than a fold line can: the per-tool
 * counts, and one row per tool with its subjects.
 *
 * So the cases below assert the same projection at its new address. The
 * three things that must NOT move are unchanged and still asserted:
 * writes/shells never group, the grouping stays display-side, and the
 * durable cells are untouched.
 *
 * W13 already rolls a run of the SAME read-only tool into one row. What
 * a model actually does when it explores is MIX them — read, read,
 * search, read, list, search — and a mixed burst fell straight through
 * W13's same-name scan into eight low-density rows.
 *
 * B generalizes the existing mechanism rather than adding a second one:
 * the run scan's break condition moves from "a different tool name" to
 * "a tool that is not read-only". A run that happens to be single-name
 * still renders W13's exact row (no supersession there); a run that
 * spans two or more read-only tools renders the exploration line.
 *
 * The three things that must NOT move, asserted below:
 *   - writes, edits, shells and extension tools never group;
 *   - the grouping is a DISPLAY-SIDE PROJECTION: the cells' own durable
 *     data (the full input, the full result) is untouched, byte for
 *     byte, whether or not the row collapsed;
 *   - /last still reaches the full outputs.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the fold's terms are
 * VERB + COUNT + NOUN now ("read 5 files"), where they used to be a
 * bare count and a noun borrowed from the rollup table ("5 reads",
 * "1 match"). Two reasons, one of them a truthfulness bug: that table
 * names what a single-tool rollup COUNTS — "14 matches" means fourteen
 * matched lines — while this line counts CALLS, so one search rendered
 * "1 match" whenever the search had matched any other number. The
 * phrasing is the owner's, from the shape they asked for: "thought 17s
 * · read 4 files · listed 1 directory · ran 4 shell commands".
 */
/**
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED.
 *
 * R3b ruled that zero terms are dropped ("a sentence about things that
 * did not happen"), and the THOUGHT term was exempt by accident: it was
 * written before the rule and never revisited. So a model that emits no
 * thinking — and these cases pass `endTurn(0)` — folded under `thought
 * 0s` in the LEAD position, every turn of its life.
 *
 * The cases below claimed "the turn folded" by looking for `✦ thought`.
 * That literal is no longer the fold's signature when the turn did no
 * thinking, so each one now names the fold by what the turn actually
 * DID — which is the claim they were making all along.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	return { body, writes, tick: () => vi.advanceTimersByTime(16), setSize: (w: number, h: number) => { W = w; H = h; } };
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** The compositor writes raw bytes with SGR spans; the assertions below
 *  are about the WORDS, so the SGR comes off first (the byte-level SGR
 *  placement is pinned in the tui-cells unit). */
function plain(stream: string): string {
	return stream.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

/** One settled read-only call. */
function call(body: Body, name: string, id: string, input: Record<string, unknown>, result: string): void {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: result, isError: false });
}

/** The prototype's burst: 8 reads and 14 searches, interleaved. */
function exploreBurst(body: Body): void {
	const files = ["src/parser.ts", "src/lexer.ts", "src/ast.ts", "src/emit.ts", "src/scan.ts", "src/fold.ts", "src/type.ts", "src/util.ts"];
	files.forEach((path, i) => call(body, "read_file", `r${i}`, { path }, "a\nb"));
	for (let i = 0; i < 6; i += 1) call(body, "search_text", `s${i}`, { pattern: "parseExpr", path: "src" }, "hit");
	for (let i = 0; i < 8; i += 1) call(body, "search_text", `t${i}`, { pattern: "Token", path: "src" }, "hit");
}

describe("TUI2-R1 T-V2 — the exploration rollup", () => {
	it("a MIXED read-only burst becomes ONE exploration row — the per-tool counts, the elapsed, the affordance", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("explore");
		exploreBurst(body);
		body.textAppend("explored.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		const frame = plain(writes.join(""));
		// R3b: the burst's COMMITTED form is the segment fold — ONE row for
		// twenty-two calls, which is the same claim this case always made,
		// one row tighter.
		expect(frame).toContain("✦ read 8 files");
		expect(frame).toContain("read 8 files · ran 14 searches"); // the fold's own terms
		expect(frame.match(/✦ read 8 files/g) ?? []).toHaveLength(1);
		// and the exploration row is what the key opens — the per-tool
		// counts and the subjects, unchanged.
		const opened = body.expandNext();
		expect(opened.kind).toBe("appended");
		const lines = opened.kind === "appended" ? plain(opened.lines.join("\n")) : "";
		expect(lines).toContain("explored 8 files · 14 searches");
		expect(lines.match(/explored /g) ?? []).toHaveLength(1);
	});

	it("a WRITE breaks the group — the two read-only runs on either side roll up separately, the write never joins", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("mix");
		call(body, "read_file", "a1", { path: "one.ts" }, "x");
		call(body, "search_text", "a2", { pattern: "q", path: "src" }, "x");
		call(body, "list_dir", "a3", { path: "src" }, "x");
		call(body, "write_file", "w1", { path: "out.ts", content: "hello" }, "wrote out.ts");
		call(body, "read_file", "b1", { path: "two.ts" }, "x");
		call(body, "search_text", "b2", { pattern: "z", path: "src" }, "x");
		call(body, "list_dir", "b3", { path: "lib" }, "x");
		body.textAppend("done.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		// R3b: the run's committed form is the fold; the GROUPING — which
		// is what this case is about — is asserted where it now lives.
		const opened = body.expandNext();
		expect(opened.kind).toBe("appended");
		const lines = opened.kind === "appended" ? plain(opened.lines.join("\n")) : "";
		// two exploration rows, and the write's own row between them: the
		// write still BREAKS the run, which is the whole claim.
		expect(lines.match(/explored/g) ?? []).toHaveLength(2);
		expect(lines).toContain("explored 1 file · 1 search · 1 dir");
		expect(lines).toContain("write out.ts");
	});

	it("a SHELL never groups — three shells in a row stay three rows", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("shells");
		for (let i = 0; i < 3; i += 1) call(body, "shell", `c${i}`, { command: `echo ${i}` }, "out");
		body.textAppend("ran.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		const opened = body.expandNext();
		const lines = opened.kind === "appended" ? plain(opened.lines.join("\n")) : plain(writes.join(""));
		expect(lines).not.toContain("explored");
		// R2: three shells, three rows — counted by the verb column now that
		// the tick is retired. R3b: inside the fold's expansion, where a
		// shell still refuses to group.
		expect(lines.match(/ {2}shell /g) ?? []).toHaveLength(3);
	});

	it("TWO calls never roll up — the threshold is the same three W13 used", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("two");
		call(body, "read_file", "a", { path: "one.ts" }, "x");
		call(body, "search_text", "b", { pattern: "q", path: "src" }, "x");
		body.textAppend("done.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		expect(plain(writes.join(""))).not.toContain("explored");
	});

	it("a SINGLE-NAME run still renders W13's exact row — the generalization adds, it never rewrites", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("w13");
		for (let i = 0; i < 5; i += 1) call(body, "read_file", `r${i}`, { path: `${"abcde"[i]}.ts` }, "line one\nline two");
		body.textAppend("five files read.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		// R3b: the committed form is the fold; W13's exact row is what the
		// key opens. "The generalization adds, it never rewrites" is still
		// the claim — the single-name run keeps W13's row rather than
		// growing an exploration one.
		expect(plain(writes.join(""))).toContain("✦ read");
		const opened = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		// one space, not two: the double space was the COMMITTED row's
		// verb-column pad (W3); the expansion is a list, not a column.
		expect(opened).toContain("read 5 files");
		expect(opened).not.toContain("explored");
	});

	it("ctrl+r LISTS THEM — one row per tool, the subjects with their ×counts, and the collapse footer", () => {
		const { body, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("explore");
		exploreBurst(body);
		body.textAppend("explored.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		const lines = (r as { lines: string[] }).lines.map(plain);
		// R3b: the header names what the SEGMENT did, in the fold line's
		// own terms; the run's "explored …" title sits one row below it.
		// Two scales, one wording each — the header used to borrow the
		// run's sentence, which read as the same run twice.
		expect(lines[0]).toContain("expanded · read 8 files · ran 14 searches · 0 turns back");
		const body_ = lines.join("\n");
		expect(body_).toContain("explored 8 files · 14 searches");
		expect(body_).toContain("│ read   src/parser.ts · src/lexer.ts · src/ast.ts (+5)");
		expect(body_).toContain('│ search "parseExpr" ×6 · "Token" ×8');
		// MOVED (R1.5 ①, the tool-cell suffix supersession class): the
		// footer used to promise "· /last shows the full outputs". /last
		// shows the LAST call only, so for this 22-call burst the promise
		// was false 21 times over (VD-15). The footer now says only what
		// the key does.
		// DECLARED SUPERSESSION (R3i phase 4): in the APPENDED path the
		// footer said `ctrl+r collapses`, which is false there — a
		// committed row is ink (ADR-0046 forbids rewriting history), so
		// nothing about this block can be taken back and the next press
		// opens the NEXT fold. The footer says what the key does. The
		// LIVE toggle keeps the old wording, where it is true.
		expect(body_).toContain("└ end of expansion · ctrl+r opens the next fold");
		expect(body_).not.toContain("/last shows the full outputs");
	});

	it("DISPLAY-SIDE PROJECTION — the row hid the members, the cells' own data is untouched", () => {
		const rolled = makeBody({ W: 80 });
		rolled.body.enter();
		rolled.body.userLine("explore");
		call(rolled.body, "read_file", "a", { path: "one.ts" }, "alpha\nbeta");
		call(rolled.body, "search_text", "b", { pattern: "q", path: "src" }, "gamma");
		call(rolled.body, "list_dir", "c", { path: "src" }, "delta");
		rolled.body.textAppend("done.");
		rolled.body.endTurn(0); // R3d: the fold is the TURN's
		rolled.tick();
		const frame = plain(rolled.writes.join(""));
		// the ROWS are gone — none of the members' result text was drawn…
		// R3b: the committed row is the segment fold rather than the
		// exploration row, and the claim this case makes — that the
		// members' CONTENT never reached the screen — is unchanged.
		expect(frame).toContain("✦ read 1 file · ran 1 search · listed 1 directory");
		for (const hidden of ["alpha", "beta", "gamma", "delta"]) expect(frame).not.toContain(hidden);
		// …and every member's own input is still there to be read back:
		// the expand walks the CELLS, so a rewrite would show up here.
		const lines = plain((rolled.body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(lines).toContain("one.ts");
		expect(lines).toContain('"q"');
		expect(lines).toContain("src");
	});

	it("/LAST still reaches the full outputs — the rollup hid rows, never content", () => {
		const { body, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("explore");
		call(body, "read_file", "a", { path: "one.ts" }, "alpha\nbeta");
		call(body, "search_text", "b", { pattern: "q", path: "src" }, "gamma");
		call(body, "list_dir", "c", { path: "src" }, "the whole listing\nsecond row");
		body.textAppend("done.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		const last = body.lastTool();
		expect(last).not.toBeNull();
		expect(last!.name).toBe("list_dir");
		expect(last!.result.content).toBe("the whole listing\nsecond row");
		expect(last!.input).toEqual({ path: "src" });
	});

	it("a run whose members are not ALL done degrades to individual rows (W13's own rule, unchanged)", () => {
		const { body, writes, tick } = makeBody({ W: 80 });
		body.enter();
		body.userLine("partial");
		call(body, "read_file", "a", { path: "one.ts" }, "x");
		call(body, "search_text", "b", { pattern: "q", path: "src" }, "x");
		body.toolStart("list_dir", "c", { path: "src" });
		body.toolRunning("c"); // still running when the text releases the hold
		body.textAppend("done.");
		body.endTurn(0); // R3d: the fold is the TURN's
		tick();
		expect(plain(writes.join(""))).not.toContain("explored");
	});
});
