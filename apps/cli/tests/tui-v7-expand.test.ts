/**
 * TUI v7 W15 — the expand key (ctrl+r), the work order's done-when:
 * "expanding a tool from three turns back prints a new block at the
 * bottom and the rows above it are byte-identical to before."
 *
 * TWO operations, one key:
 *  (1) COMMITTED cells APPEND — the /last idiom aimed at a chosen cell:
 *      `▞ expanded · <tool> <target> · N turns back` + the full input
 *      and output sections. History is never rewritten (ADR-0046) —
 *      the block is new content at the bottom; the rows above are the
 *      pre-key screen's rows, byte-identical (the emulator's grid
 *      comparison pins it).
 *  (2) LIVE cells TOGGLE in place — the compositor owns those rows and
 *      redraws them. The reachable live cell is the approval diff (its
 *      "ctrl+r to expand" affordance is the invite); the key must
 *      answer AT the approval pause, never after the run.
 *
 * Both ride the REAL key: the driver writes the raw \x12 byte through
 * the PTY, the editor's feed dispatches it.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { VtScreen } from "./helpers/vt-screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, struct, fcntl, termios, signal

def driver(cli, env, feeds, timeout, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        if cwd:
            os.chdir(cwd)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            full += data
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
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
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 60, cwd?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v7-expand-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout}, ${cwd === undefined ? "None" : JSON.stringify(cwd)})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
}

function stripANSI(text: string): string {
	return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

describe("TUI v7 W15 — the expand key (real PTY, 24×80)", () => {
	it("COMMITTED: ctrl+r on a tool from three turns back appends the expanded block — the rows above it byte-identical (the work order's done-when)", () => {
		const { env } = isolatedEnv();
		// Three turns; the FIRST's shell (`seq 1 8`) settles into the 5-row
		// tail with the ctrl+r affordance and freezes; turns 2–3 are
		// text-only. bypass: the shell runs without the approval question —
		// this gate is about the KEY, not the policy chain.
		const dir = mkdtempSync(join(tmpdir(), "kiso-v7-expand-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "seq 1 8" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "first turn built." }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "text_delta", text: "second turn." }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "text_delta", text: "third turn." }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
			[
				["▌ ", "go\r"], // the brick — the startup paint is race-proof in BOTH modes
				["built.", "go\r"], // turn 1's response → turn 2
				["second turn.", "go\r"], // turn 2's response → turn 3
				["third turn.", "\x12"], // the REAL key — the turn-1 shell has long since frozen
				["expanded · shell", "exit\r"],
			],
		);
		const clean = stripANSI(out);

		// The appended block: the /last shape aimed at the chosen cell —
		// the header names the target and how far back it sits.
		expect(clean).toContain("▞ expanded · shell seq 1 8 · 2 turns back");
		expect(clean).toContain("--- shell input ---");
		expect(clean).toContain('"command": "seq 1 8"');
		expect(clean).toContain("--- shell output ---");
		// SUPERSESSION (TUI2-R1, the tool-cell suffix class): the settled
		// shell now names its own key on the HEAD row as well as at the
		// block's cut — two affordances for one cell, each a different
		// fact (the head says how much is hidden, the cut says where the
		// visible tail begins). Both still emit exactly once: the
		// committed rows are never re-emitted after the freeze.
		// MOVED (R1.5 slice ④, the settled-shell-body class — DECLARED THIS
		// ROUND): there is no block cut any more, because there is no
		// settled block (VD-5). ONE affordance for one cell, on the head
		// row — which is what "one grammar, stated once per card" asked
		// for. The "emits exactly once" property the case exists to pin is
		// unchanged and is what the count still measures.
		// MOVED (the focus-marker class, TUI2-R2 ⑤): the count is the
		// settled cell's ONE affordance plus the live cell's focus marker,
		// when a live cell is on screen holding the focus. The property this
		// line exists to pin — "emits exactly once", i.e. the committed rows
		// are never re-emitted after the freeze — is unchanged: what the
		// count now admits is a SECOND cell's single affordance, never a
		// second copy of the first cell's.
		// DECLARED SUPERSESSION (REL-0152-R1): counted on the SCREEN, not
		// in the byte stream. The stream count was a proxy for "the
		// committed rows are never re-emitted after the freeze", which
		// held while the renderer moved rows by scrolling the terminal. A
		// diff rewrites a row whenever its content changes — and when the
		// window shifts, every row's content changes — so the same row's
		// text appears in the stream many times while appearing on screen
		// exactly once.
		//
		// The property the case is named for is about the SCREEN, and it
		// is asserted there. That a committed line reaches the scrollback
		// exactly once is the A7 replay's and TT-1B's job, and both are
		// green.
		const screenNow = new VtScreen(24, 80);
		screenNow.write(Buffer.from(out, "utf8"));
		const visible = screenNow.visible().join("\n");
		expect((visible.match(/ctrl\+r/g) ?? []).length, "one affordance per cell on screen").toBeLessThanOrEqual(2);
		expect((clean.match(/ctrl\+r/g) ?? []).length).toBeGreaterThanOrEqual(1);
		// the REAL count, at the tier this row's width affords: the bypass
		// tier's `· approved by mode:bypass` takes the room the full form
		// would have needed, so the terse tier lands — the count survives,
		// the teaching word gives way (invariant ①: the row still fits 80).
		// MOVED (R1.5 slice 5, the approval-attribution class — DECLARED
		// THIS ROUND): a POLICY verdict is ambient and silent; a HUMAN
		// verdict is what the row records. `approved by mode:*` was the
		// runtime's backfill for "no policy expressed an opinion", read by
		// a human as an attribution (VD-11).
		expect(clean).toMatch(/\(exit 0, \d+\.\ds\) · 8 lines · ctrl\+r expands/);

		// THE DONE-WHEN: split the stream at the block's first byte — the
		// pre-key part is the state before the key. The emulator replays
		// both sides; the block lands as NEW content, and the rows above
		// it are the pre-key screen's rows at the same positions,
		// byte-identical (the append never touched them).
		// The header splits as `▞` + reset + ` expanded` in the raw bytes,
		// so the search anchors on the post-reset text.
		const at = out.indexOf("expanded · shell seq 1 8");
		expect(at).toBeGreaterThan(0);
		const pre = new VtScreen(24, 80);
		pre.write(Buffer.from(out.slice(0, at), "utf8"));
		const gridA = pre.visible();
		const full = new VtScreen(24, 80);
		full.write(Buffer.from(out, "utf8"));
		const gridB = full.visible();
		const r = gridB.findIndex((l) => l.includes("▞ expanded"));
		expect(r).toBeGreaterThan(0);
		// the block's own rows: header, the sections, the full result. The
		// blank rows between the sections are the container's W11 spacing
		// (bodySpacing: a blank before a multi-row cell) — the block is ONE
		// logged sequence, the blanks belong to its layout.
		expect(gridB[r]!).toContain("expanded · shell seq 1 8 · 2 turns back");
		expect(gridB[r + 1]!).toBe("--- shell input ---");
		expect(gridB[r + 3]!).toBe("{");
		expect(gridB[r + 4]!).toBe('  "command": "seq 1 8"');
		expect(gridB[r + 5]!).toBe("}");
		expect(gridB[r + 7]!).toBe("--- shell output ---");
		for (let i = 0; i < 8; i += 1) expect(gridB[r + 9 + i]!).toBe(String(i + 1));
		// the rows ABOVE the block: the pre-key screen's rows, byte-identical
		expect(gridB.slice(0, r)).toEqual(gridA.slice(0, r));
	}, 120_000);

	it("LIVE: the approval panel shows the ALWAYS-verbose diff at the pause (the fold cap + the notice row); a second key on the settled cell appends nothing", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v7-expand-"));
		const target = join(dir, "target.txt");
		const script = join(dir, "faux.json");
		const content = Array.from({ length: 15 }, (_, i) => `line${String(i).padStart(2, "0")}`).join("\n");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "tool_call_end", callId: "c1", name: "write_file", input: { path: target, content, expectedRevision: "absent" } },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "written." }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				// The v8 panel replaces the live cut — the ALWAYS-verbose diff
				// is up immediately (the 15-line write folds at the H−4 cap
				// with the notice row; the ctrl+r affordance is GONE).
				// Answer with 1 (Yes) + enter.
				["needs approval — asked by", "y\r"],
				["written.", "\x12"], // the second key: the cell is settled+committed
				["nothing to expand", "exit\r"],
			],
		);
		const clean = stripANSI(out);

		// The panel showed the FULL diff without any toggle — the middle rows
		// the old cut hid are up from the start; the affordance is the
		// panel's, and the fold cap carried the notice row.
		expect(clean).toContain("↑↓ move · ⏎ or click confirms · 1-4 instant · esc");
		expect(clean).toContain("more rows — the full args are in the event log");
		expect(clean).toContain("line07"); // the always-verbose middle — never hidden
		expect(clean).not.toContain("ctrl+r to expand"); // the live cut is gone — the panel superseded it
		// The second key appended nothing — the settled cell was never cut
		// with the affordance (its committed form is the result text), so
		// the answer is the empty message, not a block.
		expect(clean).not.toContain("▞ expanded");
		expect(clean).toContain("[nothing to expand]");
		// The write really happened (the answer flow completed).
		expect(clean).toContain("written.");
	}, 120_000);

	it("W13: the 5-read_file run rolls up — the claimed group row, the first-3 children, the overflow, and the expand (real PTY, 24×80)", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v7-expand-"));
		// the reads run in the temp dir as the workspace (the child chdirs —
		// the tools refuse ABSOLUTE paths, and the repo tree stays clean)
		const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
		for (const n of names) writeFileSync(join(dir, n), "line one\nline two\nline three\n");
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						...names.map((p, i) => ({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: p } })),
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "five files read." }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
			[
				["▌ ", "go\r"], // the brick — the startup paint is race-proof in BOTH modes
				// the key rides the rollup's OWN committed row (its bytes land
				// after the frame's capture completed — never the text's live
				// bytes, which can precede the commit by a frame)
				["read  5 files", "\x12"],
				["expanded · read 5 files", "exit\r"],
			],
			60,
			dir,
		);
		const clean = stripANSI(out);

		// the claimed group shape: the verbCol's double space, the line
		// count of the 5 real reads (3 lines each → 15), the elapsed
		expect(clean).toMatch(/read {2}5 files \(\d+ lines, \d+\.\ds\)/);
		// the children: the first 3 basename targets; the overflow names
		// the rest and carries the ctrl+r affordance
		expect(clean).toContain("a.ts · b.ts · c.ts");
		expect(clean).toContain("+2 more — ctrl+r expands");
		// the expand: the FULL per-call children, one └ row each — a.ts
		// appears twice (the rollup's joined children row starts the └;
		// b/c ride "· ", so only the expand's own └ matches for them);
		// d–e once (only the expand ever named them)
		expect(clean).toContain("expanded · read 5 files · 0 turns back");
		// DECLARED SUPERSESSION (REL-0152-R1), same class as above: counted
		// on the SCREEN. A diff re-emits a row when the window shifts, so
		// a stream count no longer measures "how many of these are there".
		const screenNow2 = new VtScreen(24, 80);
		screenNow2.write(Buffer.from(out, "utf8"));
		expect(screenNow2.visible().join("\n").match(/└ a\.ts/g) ?? []).toHaveLength(2);
		// the same supersession, applied to the siblings: on the SCREEN
		const vis2 = screenNow2.visible().join("\n");
		expect(vis2.match(/└ b\.ts/g) ?? []).toHaveLength(1);
		expect(vis2.match(/└ c\.ts/g) ?? []).toHaveLength(1);
		expect(vis2.match(/└ d\.ts/g) ?? []).toHaveLength(1);
		expect(vis2.match(/└ e\.ts/g) ?? []).toHaveLength(1);
	}, 120_000);

	it("W14: the QUIET turn — thinking + 5 reads with NO text: the fold line replaces the turn at the terminal (real PTY, 24×80)", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v7-expand-"));
		const names = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
		for (const n of names) writeFileSync(join(dir, n), "line one\nline two\n");
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "thinking", text: "thinking quietly" },
						...names.map((p, i) => ({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: p } })),
						{ type: "stop", reason: "tool_use" },
					],
				},
				// the stop-only turn: nothing pending, end_turn → the
				// completed terminal — the turn has NO text (the fold's
				// precondition: a quiet turn ends in the ONE fold line)
				{ events: [{ type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
			[
				["▌ ", "go\r"],
				// the fold line's own bytes — the turn ended, the reads
				// folded (the needle is the contiguous term text)
				["5 reads · no edits", "exit\r"],
			],
			60,
			dir,
		);
		const clean = stripANSI(out);

		// the claimed fold shape: the wall-clocked thought seconds, the
		// reads term, the no-edits term — the ONE line for the whole turn
		expect(clean).toMatch(/thought \d+s · 5 reads · no edits/);
		expect(clean).toContain("▞");
		// no rollup ever happened (the fold precedes it — the turn had no
		// text to release with)
		expect(clean).not.toContain("5 files");
	}, 120_000);
});
