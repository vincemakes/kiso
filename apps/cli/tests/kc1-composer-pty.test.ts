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
			["› ", paste, 2],
			["WHERE x = 1", "\r", 4], // Enter — the composer's rows are on the screen by now
		], 16);
		const grids = frameGrids(out);

		// ① the box GREW: a frame with the box top at H−5 (row index 18),
		//    the three pasted rows inside it, and the bottom right after
		const grown = grids.find(
			(g) => g[18]!.includes("╭") && g[19]!.includes("SELECT id") && g[20]!.includes("FROM t") && g[21]!.includes("WHERE x = 1") && g[22]!.includes("╰"),
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
		expect(grid[20]!.includes("╭")).toBe(true);
		expect(grid[22]!.includes("╰")).toBe(true);
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
			["› ", "one\x0atwo\x0athree", 2], // Ctrl+J ×2 — the composer grows LIVE
			["three", "\r", 4], // Enter — the submit collapses it and starts the run
			["one", "queued one\x0aqueued two\x0aqueued three", 6], // typed WHILE the shell sleeps
			["queued three", "\r", 8], // the second submit — it QUEUES behind the run
		], 22);
		const grids = frameGrids(out);

		// ① the composer grew to three rows under Ctrl+J
		const grown = grids.find((g) => g[18]!.includes("╭") && g[19]!.includes("one") && g[20]!.includes("two") && g[21]!.includes("three") && g[22]!.includes("╰"));
		expect(grown, "a frame shows three composer rows typed with Ctrl+J").toBeDefined();

		// ② the submit COLLAPSED it — a later frame has the one-row box back
		const grownAt = grids.indexOf(grown!);
		const collapsed = grids.slice(grownAt + 1).find((g) => g[20]!.includes("╭") && g[22]!.includes("╰") && !g[19]!.includes("│"));
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
