/**
 * TUI v7 W15 — the expand key (ctrl+r), the work order's done-when:
 * "expanding a tool from three turns back prints a new block at the
 * bottom and the rows above it are byte-identical to before."
 *
 * TWO operations, one key:
 *  (1) COMMITTED cells APPEND — the /last idiom aimed at a chosen cell:
 *      `✦ expanded · <tool> <target> · N turns back` + the full input
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
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED, so
 * the fold's lead term is OPTIONAL in these patterns. R3b ruled that a
 * zero term is a sentence about something that did not happen; the
 * thought term was exempt by accident (written before the rule). The
 * faux model emits no thinking, so every fold here led with `thought
 * 0s` — which is exactly the sentence the rule forbids.
 */
import { spawnSync } from "node:child_process";
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
    # R3g: report HOW the scenario ended, and which feeds never fired.
    # This file's own driver had no such report, and twice a needle this
    # round's wording changed out from under went unnoticed: the driver
    # waited out its whole 60s budget, the CLI was SIGTERM'd, and the
    # assertions passed on the truncated transcript. Two cases at 60.1s
    # each also blocked the worker's event loop long enough to starve
    # vitest's own RPC, which fails the RUN with every test green — the
    # most expensive way possible to learn that a needle is dead.
    unfed = ",".join(str(i) for i in range(len(feeds)) if i not in fed)
    sys.stderr.write("KISO_PTY_END " + ("eof" if done else "wall") + " " + ("%.2f" % (time.time() - (end - timeout))) + " " + unfed + chr(10))
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
	const res = spawnSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
	if (res.error !== undefined && res.error !== null) throw res.error;
	const end = /KISO_PTY_END (eof|wall) ([\d.]+) ?(.*)/.exec(res.stderr ?? "");
	if (end !== null && end[1] === "wall") {
		const dead = (end[3] ?? "")
			.split(",")
			.filter((x) => x !== "")
			.map((i) => JSON.stringify(feeds[Number(i)]?.[0] ?? "?"));
		throw new Error(
			`the PTY scenario spent its whole ${timeout}s wall (${end[2]}s) — the CLI never exited. ` +
				(dead.length > 0 ? `These needles never appeared: ${dead.join(", ")}. ` : "") +
				"A scenario that waits out its budget passes its assertions on a SIGTERM'd transcript and hides the stall (R3c).",
		);
	}
	return res.stdout;
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
		expect(clean).toContain("✦ expanded · shell seq 1 8 · 2 turns back");
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
		// The header splits as `✦` + reset + ` expanded` in the raw bytes,
		// so the search anchors on the post-reset text.
		const at = out.indexOf("expanded · shell seq 1 8");
		expect(at).toBeGreaterThan(0);
		const pre = new VtScreen(24, 80);
		pre.write(Buffer.from(out.slice(0, at), "utf8"));
		const gridA = pre.visible();
		const full = new VtScreen(24, 80);
		full.write(Buffer.from(out, "utf8"));
		const gridB = full.visible();
		const r = gridB.findIndex((l) => l.includes("✦ expanded"));
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
		expect(clean).not.toContain("✦ expanded");
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
				// the key rides the FOLD's own committed row (R3b: the run's
				// settled form). Its bytes land after the frame's capture
				// completed — never the text's live bytes, which can precede
				// the commit by a frame.
				["five files read.", "\x12"],
				["expanded · read 5 files", "exit\r"],
			],
			60,
			dir,
		);
		const clean = stripANSI(out);

		// DECLARED SUPERSESSION (R3b, owner ruling): the run's SETTLED form
		// is the segment fold; W13's row, its children and the overflow
		// moved behind `ctrl+r`. What this case is really about — the
		// expand reaching the FULL per-call children — is unchanged and is
		// asserted below.
		expect(clean).toMatch(/✦ (thought \d+s · )?read 5 files/);
		// the expand: the FULL per-call children, one └ row each — a.ts
		// appears twice (the rollup's joined children row starts the └;
		// b/c ride "· ", so only the expand's own └ matches for them);
		// d–e once (only the expand ever named them)
		// the header names the SEGMENT; W13's own row sits one line below it
		expect(clean).toContain("expanded · read 5 files · 0 turns back");
		expect(clean).toContain("read 5 files");
		// DECLARED SUPERSESSION (REL-0152-R1), same class as above: counted
		// on the SCREEN. A diff re-emits a row when the window shifts, so
		// a stream count no longer measures "how many of these are there".
		const screenNow2 = new VtScreen(24, 80);
		screenNow2.write(Buffer.from(out, "utf8"));
		// R3b: ONE `└ a.ts`, not two. The second came from the rollup's own
		// committed children row ("a.ts · b.ts · c.ts"), which moved behind
		// the key with the rest of the run — so a.ts is now named exactly
		// where b–e are, which is the shape this case wanted all along.
		expect(screenNow2.visible().join("\n").match(/└ a\.ts/g) ?? []).toHaveLength(1);
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
				// R3b: `no edits` is gone (zero terms are dropped), and a needle
				// that never fires does not FAIL — the driver simply waits out
				// its whole budget and the assertions still pass on the final
				// output. That silent 60s is what tripped vitest's 60s RPC
				// deadline for the whole file.
				["read 5 files", "exit\r"],
			],
			60,
			dir,
		);
		const clean = stripANSI(out);

		// the claimed fold shape: the wall-clocked thought seconds and the
		// reads term — the ONE line for the whole turn. R3b (owner ruling):
		// zero terms are dropped, so there is no `no edits` to assert.
		expect(clean).toMatch(/(thought \d+s · )?read 5 files/);
		expect(clean).not.toContain("no edits");
		expect(clean).toContain("✦");
		// no rollup ever happened (the fold precedes it — the turn had no
		// text to release with).
		//
		// R3g: the needle used to be the bare "5 files", which the FOLD
		// now says too — verb+count+noun made the two wordings collide,
		// and the case contradicted itself (the line above requires the
		// same substring this one forbade). The rollup's own shape is
		// what distinguishes it: a two-space gutter, the verb, and the
		// parenthetical it carries and the fold never does.
		expect(clean).not.toMatch(/ {2}read {2}5 files \(/);
	}, 120_000);
});
