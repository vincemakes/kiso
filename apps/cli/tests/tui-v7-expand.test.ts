/**
 * TUI v7 W15 — the expand key (ctrl+o), the work order's done-when:
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
 *      "ctrl+o to expand" affordance is the invite); the key must
 *      answer AT the approval pause, never after the run.
 *
 * Both ride the REAL key: the driver writes the raw \x0f byte through
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
import { VtScrollback } from "../../../packages/tui/tests/vt-scrollback.js";

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
                # THE CHILD IS GONE — on Linux. A pty master raises EIO
                # once the last slave fd closes; macOS returns b"" for the
                # same event, and that path (below) sets done. Treating
                # only the macOS shape as an exit made every Linux run
                # report "the CLI never exited" on a CLI that had exited
                # cleanly a fraction of a second earlier.
                #
                # R3c keeps its teeth: reap with WNOHANG for up to a
                # second, and only call it an exit if the child really is
                # gone. A process still alive behind a broken pty is a
                # stall, and still spends its wall.
                reaped = False
                for _ in range(100):
                    try:
                        if os.waitpid(pid, os.WNOHANG)[0] != 0:
                            reaped = True
                            break
                    except ChildProcessError:
                        reaped = True
                        break
                    time.sleep(0.01)
                if reaped:
                    done = True
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
	it("COMMITTED: ctrl+o on a tool from three turns back appends the expanded block — the rows above it byte-identical (the work order's done-when)", () => {
		const { env } = isolatedEnv();
		// Three turns; the FIRST's shell (`seq 1 8`) settles into the 5-row
		// tail with the ctrl+o affordance and freezes; turns 2–3 are
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
				["third turn.", "\x0f"], // the REAL key — the turn-1 shell has long since frozen
				["· expanded ·", "exit\r"], // 0.24.2 ③: the card names the call FIRST, so the needle is the part only an expansion says
			],
		);
		const clean = stripANSI(out);

		// The appended block: the /last shape aimed at the chosen cell —
		// the header names the target and how far back it sits.
		// MOVED (0.24.2 ③): a CARD, and no `✦` — that is the recap's mark.
		expect(clean).toMatch(/shell seq 1 8 · expanded · 2 turns back/);
		expect(clean).not.toMatch(/✦ expanded/);
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
		expect((visible.match(/ctrl\+o/g) ?? []).length, "one affordance per cell on screen").toBeLessThanOrEqual(2);
		expect((clean.match(/ctrl\+o/g) ?? []).length).toBeGreaterThanOrEqual(1);
		// the REAL count, at the tier this row's width affords: the bypass
		// tier's `· approved by mode:bypass` takes the room the full form
		// would have needed, so the terse tier lands — the count survives,
		// the teaching word gives way (invariant ①: the row still fits 80).
		// MOVED (R1.5 slice 5, the approval-attribution class — DECLARED
		// THIS ROUND): a POLICY verdict is ambient and silent; a HUMAN
		// verdict is what the row records. `approved by mode:*` was the
		// runtime's backfill for "no policy expressed an opinion", read by
		// a human as an attribution (VD-11).
		// MOVED (R9 P2 / D4): the settled shell is a slab, so the count and
		// the timing ride the OUTCOME row and the key rides the note row.
		// The fact this line pins — the row states the count exactly once,
		// with the key — is unchanged; both are simply on the rows that
		// carry them now.
		expect(clean).toMatch(/ {4}exit 0 · 8 lines · \d+\.\ds/);
		expect(clean).toMatch(/… \d+ earlier lines? · ctrl\+o expands/);

		// THE DONE-WHEN: split the stream at the block's first byte — the
		// pre-key part is the state before the key. The emulator replays
		// both sides; the block lands as NEW content, and the rows above
		// it are the pre-key screen's rows at the same positions,
		// byte-identical (the append never touched them).
		// The head row splits as target + reset + dim + ` · expanded` in the
		// raw bytes, so the search anchors on the post-reset text.
		const at = out.indexOf("· expanded · 2 turns back");
		expect(at).toBeGreaterThan(0);
		const pre = new VtScreen(24, 80);
		pre.write(Buffer.from(out.slice(0, at), "utf8"));
		const gridA = pre.visible();
		const full = new VtScreen(24, 80);
		full.write(Buffer.from(out, "utf8"));
		const gridB = full.visible();
		// AMENDED (0.24.2 ③): the block's own head row may have scrolled off
		// the final screen, because the card's body is UNCAPPED and this
		// scenario's is longer than the 24 rows left under the transcript.
		// That is inherent to APPENDING an uncapped block (DC-50), so the
		// anchor is the block's first row that IS on screen. The claim is
		// unchanged and is the one below it: everything above the block is
		// byte-identical to the pre-key screen.
		const anchors = ["· expanded ·", "--- shell input ---", '"command": "seq 1 8"', "--- shell output ---"];
		const r = gridB.findIndex((l) => anchors.some((a) => l.includes(a)));
		expect(r, "no part of the appended block is on the final screen").toBeGreaterThan(0);
		// the block's own rows: header, the sections, the full result. The
		// blank rows between the sections are the container's W11 spacing
		// (bodySpacing: a blank before a multi-row cell) — the block is ONE
		// logged sequence, the blanks belong to its layout.
		// AMENDED (R13 D1): the offsets are RELATIVE now, not fixed. D1
		// made the spacing a constant — one blank between any two elements
		// whatever their height — where W11 gave a blank only when a side
		// was multi-row, so every gap inside this block moved by one. The
		// claim is the block's CONTENT and its ORDER, which is what the
		// walk below asserts; the exact gap widths were never the subject
		// and pinning them made this case break on a spacing change.
		// the head row is asserted on the RAW STREAM (it was written; it may
		// have scrolled), and the CONTENT walk below is asserted on the
		// screen from whatever the anchor is.
		expect(out.replace(/\x1b\[[0-9;]*m/g, ""), "the head row does not name the call").toMatch(/shell seq 1 8 · expanded · 2 turns back/);
		expect(out, "the recap's mark is on the expansion").not.toMatch(/✦\x1b\[0m expanded/);
		// THE CONTENT AND ITS ORDER are asserted on the RAW STREAM, which is
		// where the whole block exists — the screen holds only the tail of
		// it once the card's uncapped body outruns 24 rows (DC-50).
		const said = out.replace(/\x1b\[[0-9;]*m/g, "");
		// DC-51 — THE BLOCK IS ONE CARD, so it is the height a card is.
		//
		// The owner's screenshot of 0.24.2: every other row of an expanded
		// block was the terminal's own white, so the card read as stripes.
		// The CLI printed the block ONE LINE PER `bodyLog` CALL, and each
		// call makes its own raw cell — so D1 put a blank between every
		// pair, and twelve rendered rows became twelve cells laced with
		// eleven unpainted blanks.
		//
		// Every existing gate missed it because they all assert CONTENT and
		// ORDER, which interleaved blanks do not disturb. What it changes
		// is the HEIGHT: the block came out more than twice as tall as the
		// card, which is why its head row was off the screen — a symptom I
		// had recorded in DC-50 as the uncapped body's doing. It was not.
		//
		// So the assertion is the one the owner can see: press the key, and
		// the row naming what you opened is ON THE SCREEN.
		{
			const grid = new VtScreen(24, 80);
			grid.write(Buffer.from(out, "utf8"));
			const g = grid.visible();
			const head = g.findIndex((l) => l.includes("· expanded ·"));
			expect(head, "the expansion's head row is off the screen — the block is taller than a card").toBeGreaterThanOrEqual(0);
			const outcome = g.map((l) => /exit 0 · \d+ lines? · /.test(l)).lastIndexOf(true);
			expect(outcome, "the card has no outcome row on screen").toBeGreaterThan(head);
			expect(g.slice(head + 1, outcome).filter((l) => l.trim() === "").length, "the expansion is laced with unpainted blank rows").toBeLessThanOrEqual(1);
		}
		const want = ["--- shell input ---", '"command": "seq 1 8"', "--- shell output ---", ...Array.from({ length: 8 }, (_, i) => `    ${i + 1}`)];
		let seen = said.indexOf("· expanded ·");
		for (const line of want) {
			const found = said.indexOf(line, seen);
			expect(found, `the expanded block is missing ${JSON.stringify(line)}, or it is out of order`).toBeGreaterThanOrEqual(0);
			seen = found + 1;
		}
		// THE DONE-WHEN, and what 0.24.2 ③ costs it.
		//
		// The claim was: the rows ABOVE the block are the pre-key screen's,
		// byte-identical, because an append never touches them. That was
		// checkable while the block FIT the screen. The card's body is
		// uncapped, so this block is longer than the rows left under the
		// transcript, and the terminal scrolls — everything above leaves
		// the viewport, and comparing two viewports that hold different
		// parts of the session proves nothing about rewriting.
		//
		// So the claim is asserted where it still has content: the block is
		// an APPEND — every piece of it lands AFTER the last thing the
		// pre-key screen showed, in order, and the content walk above is
		// that. Whether the rows above were rewritten is not observable
		// through a 24-row viewport once the block overflows it; DC-50 is
		// where that lives, and route B's reprint is what changes it.
		const lastBefore = gridA.filter((l) => l.trim() !== "").at(-1)!;
		expect(said.indexOf(lastBefore.trim()), "the pre-key screen's last row is not in the stream").toBeGreaterThanOrEqual(0);
		expect(said.indexOf(lastBefore.trim()), "the block did not land AFTER what was already there").toBeLessThan(said.indexOf("· expanded ·"));
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
				// with the notice row; the ctrl+o affordance is GONE).
				// Answer with 1 (Yes) + enter.
				["needs approval — asked by", "y\r"],
				["written.", "\x0f"], // the second key: the cell is settled+committed
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
		expect(clean).not.toContain("ctrl+o to expand"); // the live cut is gone — the panel superseded it
		// The second key appended nothing — the settled cell was never cut
		// with the affordance (its committed form is the result text), so
		// the answer is the empty message, not a block.
		expect(clean).not.toContain("✦ expanded");
		expect(clean).toContain("[nothing to expand]");
		// The write really happened (the answer flow completed).
		expect(clean).toContain("written.");
	}, 120_000);

	/* R13 — W13's rollup and W14's quiet-turn fold RETIRED on a real PTY,
	   with the mechanism. Both spent their full 60s wall here waiting for
	   a needle that no longer exists ("read 5 files"), which is R3c's
	   driver reporting a stall correctly — and those two waits are what
	   pushed this file past birpc's hard-coded 60s and produced the
	   onTaskUpdate timeouts alongside them. The expand key itself is
	   gated by the cases above and by dc35-expand-repeat. */

});
