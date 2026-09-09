/**
 * KC1 T-P1 / T-P2 — the multi-line composer through a REAL pty, with
 * the VT emulator replaying the transcript FRAME BY FRAME (the box
 * grows and collapses mid-session; the final screen alone cannot see
 * it).
 *
 * T-P1  a 3-line SQL block with CRLF endings arrives as ONE bracketed
 *       paste → the box grows to three rows → Enter → ONE turn whose
 *       DURABLE user_input carries exactly two 0x0A (the CRLF pairs
 *       normalized, never doubled) → the answer, the recap and the
 *       idle chrome survive on the settled screen.
 * T-P2  Ctrl+J grows the box live; the submit collapses it to one row;
 *       a multi-line turn queued during the run renders its chip as
 *       the FIRST line + the ⏎×2 suffix (adjudication A4).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { VtScreen } from "./helpers/vt-screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, session, env, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat", session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    fed = set()
    t0 = time.time()
    end = t0 + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
        for i, (needle, text, delay) in enumerate(feeds):
            if i not in fed and time.time() - t0 >= delay and needle.encode() in full:
                # OR-11: a feed may RESIZE instead of typing. The composer's
                # bugs have always lived on the resize path (R14, DC-33), so
                # a wrap gate that never narrows the terminal is not a wrap
                # gate. Additive: every existing feed still just types.
                if text.startswith("__COLS__"):
                    cols = int(text[8:])
                    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0))
                    os.kill(pid, signal.SIGWINCH)
                else:
                    os.write(fd, text.encode())
                fed.add(i)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

/** run the built CLI under a 24×80 pty; the transcript comes back as hex */
function ptyRun(env: NodeJS.ProcessEnv, session: string, feeds: [string, string, number][], timeout: number): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc1-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 180_000, env: process.env });
}

/** every FRAME's screen — the transcript split at the synchronized-output
 *  opener (the compositor wraps each frame in ?2026h … ?2026l), replayed
 *  cumulatively into one emulator: what the human saw, frame by frame. */
function frameGrids(hex: string): string[][] {
	const buf = Buffer.from(hex, "hex");
	const sync = Buffer.from("\x1b[?2026h", "ascii");
	const emu = new VtScreen(24, 80);
	const grids: string[][] = [];
	let start = 0;
	while (start < buf.length) {
		let next = buf.indexOf(sync, start + 1);
		if (next === -1) next = buf.length;
		emu.write(buf.subarray(start, next));
		grids.push([...emu.visible()]);
		start = next;
	}
	return grids;
}

/** the durable session's user_input records — the JSONL's envelope is
 *  {runId, ts, event}, so the content read here is the DURABLE one the
 *  replay and the model request both see */
function userInputs(home: string, session: string): string[] {
	const raw = readFileSync(join(home, "sessions", `${session}.jsonl`), "utf8");
	return raw
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => (JSON.parse(l) as { event?: { type?: string; content?: unknown } }).event)
		.filter((e): e is { type: string; content: unknown } => e?.type === "user_input")
		.map((e) => (typeof e.content === "string" ? e.content : ""));
}

const fauxScript = (dir: string, turns: unknown[]): string => {
	const p = join(dir, "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
};

describe("KC1 T-P1 — a pasted 3-line CRLF block is ONE multi-line turn (real PTY, 24×80)", () => {
	it("the box grows to three rows, Enter sends ONE turn, the durable content carries exactly two newlines, and the recap + idle chrome survive", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc1-p1-"));
		const script = fauxScript(dir, [{ events: [{ type: "text_delta", text: "the query reads three lines" }, { type: "stop", reason: "end_turn" }] }]);
		// the paste: CRLF line endings, the shape a real SQL copy carries
		const paste = "\x1b[200~SELECT id\r\nFROM t\r\nWHERE x = 1\x1b[201~";
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script }, "kc1p1", [
			["/ commands · \u2191 history", paste, 2],
			["WHERE x = 1", "\r", 4], // Enter — the composer's rows are on the screen by now
		], 16);
		const grids = frameGrids(out);

		// ① the box GREW: a frame with the box top at H−5 (row index 18),
		//    the three pasted rows inside it, and the bottom right after
		// DECLARED SUPERSESSION (R2, law 1.1): W6's rounded box is retired.
		// Both edges are the SAME dashed rule and the sides are gone, so
		// the corners cannot be the needle. The GEOMETRY this case is
		// about is untouched — the composer still grows upward from H−3
		// and CHROME_ROWS is still 4 — so the rails are what identify it.
		const grown = grids.find(
			(g) =>
				g[18]!.includes("\u2500") &&
				g[19]!.includes("SELECT id") &&
				g[20]!.includes("FROM t") &&
				g[21]!.includes("WHERE x = 1") &&
				g[22]!.includes("\u2500"),
		);
		expect(grown, "a frame shows the composer at three rows").toBeDefined();

		// ② the DURABLE turn: ONE user_input, the CRLF pairs normalized to
		//    exactly two 0x0A (never four, never spaces)
		const inputs = userInputs(dirs.home, "kc1p1");
		expect(inputs).toEqual(["SELECT id\nFROM t\nWHERE x = 1"]);
		expect([...inputs[0]!].filter((c) => c === "\n").length).toBe(2);

		// ③ the settled screen: the answer is there, the box is back to ONE
		//    row (top at H−3 = row index 20), and the idle chrome survives
		const grid = grids.at(-1)!;
		expect(grid.join("\n")).toContain("the query reads three lines");
		expect(grid[20]!.includes("\u2500")).toBe(true); // R2: the rails, not the corners
		expect(grid[21]!.includes("\u2500")).toBe(false); // the input row between them
		expect(grid[22]!.includes("\u2500")).toBe(true);
		expect(grid[23]).toContain("/ commands");
		// the user's own turn rides the scrollback as a chip, all three lines
		const scrollback = Buffer.from(out, "hex").toString("utf8");
		for (const line of ["SELECT id", "FROM t", "WHERE x = 1"]) expect(scrollback).toContain(line);
	}, 180_000);
});

describe("KC1 T-P2 — Ctrl+J grows the box; the submit collapses it; a queued multi-line chip shows ⏎×2", () => {
	it("three Ctrl+J lines render three rows, the submit returns one row, and the queued turn's chip carries its first line + ⏎×2", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc1-p2-"));
		// turn 1 runs a slow shell (bypass mode auto-approves) so the
		// SECOND submit lands while the run is in flight — the queue chip
		const script = fauxScript(dir, [
			{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "sleep 4" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "first turn done" }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "second turn done" }, { type: "stop", reason: "end_turn" }] },
		]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" }, "kc1p2", [
			["/ commands · \u2191 history", "one\x0atwo\x0athree", 2], // Ctrl+J ×2 — the composer grows LIVE
			["three", "\r", 4], // Enter — the submit collapses it and starts the run
			["one", "queued one\x0aqueued two\x0aqueued three", 6], // typed WHILE the shell sleeps
			["queued three", "\r", 8], // the second submit — it QUEUES behind the run
		], 22);
		const grids = frameGrids(out);

		// ① the composer grew to three rows under Ctrl+J
		// R2 (law 1.1): the rails, not the corners — see T-P1 above.
		const grown = grids.find(
			(g) => g[18]!.includes("\u2500") && g[19]!.includes("one") && g[20]!.includes("two") && g[21]!.includes("three") && g[22]!.includes("\u2500"),
		);
		expect(grown, "a frame shows three composer rows typed with Ctrl+J").toBeDefined();

		// ② the submit COLLAPSED it — a later frame has the one-row box back
		const grownAt = grids.indexOf(grown!);
		// R2: collapsed = the rails back at 20/22 with NO rail (and so no
		// composer row) at 19. The old test read `!g[19].includes("│")` —
		// the box's left wall, which no longer exists.
		const collapsed = grids.slice(grownAt + 1).find((g) => g[20]!.includes("\u2500") && g[22]!.includes("\u2500") && !g[19]!.includes("\u2500"));
		expect(collapsed, "a later frame shows the box back at one row").toBeDefined();

		// ③ the QUEUED multi-line turn's chip: its first line + ⏎×2
		const chip = grids.find((g) => g.some((row) => row.includes("queued one") && row.includes("⏎×2")));
		expect(chip, "the queue chip shows the first line and the ⏎×2 suffix").toBeDefined();

		// ④ both turns really ran, each with its newlines intact
		const inputs = userInputs(dirs.home, "kc1p2");
		expect(inputs).toContain("one\ntwo\nthree");
		expect(inputs).toContain("queued one\nqueued two\nqueued three");
	}, 180_000);
});

/**
 * OR-11 T-P3 — a long line WRAPS on a real terminal, and re-folds when
 * the terminal narrows.
 *
 * The unit gates prove the fold; this proves the CLAIM on the absolute
 * grid T-P1 measures: a hundred characters typed into a 24×80 composer
 * occupy TWO rows between the rails, narrowing to 40 columns re-folds
 * them to three, and Enter still submits ONE logical line — the whole
 * hundred characters, not the row the cursor happened to be on.
 *
 * The cursor's own row is asserted in the unit gates (`cursorRow`); what
 * a grid can see is the geometry, and that is what is read here.
 */
describe("OR-11 T-P3 — the composer wraps, and re-folds on a resize (real PTY, 24×80)", () => {
	const LINE = "wrap".repeat(25); // 100 characters, with no space to break on

	it("100 typed characters occupy TWO rows between the rails at 80 columns", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc1-p3a-"));
		const script = fauxScript(dir, [{ events: [{ type: "text_delta", text: "unused" }, { type: "stop", reason: "end_turn" }] }]);
		// deliberately NOT submitted: the composer holding the line is what
		// is being measured, and a submit collapses it to one row before the
		// transcript ends.
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script }, "kc1p3a", [["/ commands · \u2191 history", LINE, 2]], 8);
		const grid = frameGrids(out).at(-1)!;
		// the budget is 80 − 0 (the bound lead) − 1 = 79, so a hundred
		// characters are two rows; the rails move up by exactly one from
		// the one-row case T-P1 settles on (20/22 → 19/22).
		expect(grid[19]!.includes("\u2500"), "the top rail moved up one row").toBe(true);
		expect(grid[20]).toContain("wrapwrap");
		expect(grid[21]).toContain("wrap");
		expect(grid[22]!.includes("\u2500"), "the bottom rail is where it always is").toBe(true);
		// and no scroll marker anywhere: every character is on the screen
		expect(grid.slice(19, 23).join("")).not.toContain("\u2026");
	}, 180_000);

	it("narrowing the terminal re-folds the SAME line to three rows, and Enter still sends one logical line", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-kc1-p3b-"));
		const script = fauxScript(dir, [{ events: [{ type: "text_delta", text: "one long line received" }, { type: "stop", reason: "end_turn" }] }]);
		const out = ptyRun({ ...env, KISO_FAUX_SCRIPT: script }, "kc1p3b", [
			["/ commands · \u2191 history", LINE, 2],
			// the needle is the thing about to be asserted — the composer
			// carrying the line — never a neighbouring event that races the
			// repaint which draws it.
			[LINE.slice(0, 40), "__COLS__40", 4],
			[LINE.slice(0, 40), "\r", 7],
		], 20);
		const grids = frameGrids(out);

		// at 40 columns the budget is 39: the same hundred characters are
		// three rows, and the rails move up again (18/22).
		const narrow = grids.find((g) => g[18]!.includes("\u2500") && g[19]!.includes("wrap") && g[20]!.includes("wrap") && g[21]!.includes("wrap") && g[22]!.includes("\u2500"));
		expect(narrow, "a frame shows it re-folded to three rows").toBeDefined();

		// Enter submits ONE logical line — the whole hundred characters,
		// not the row the cursor happened to be on.
		expect(userInputs(dirs.home, "kc1p3b")).toEqual([LINE]);
	}, 180_000);
});
