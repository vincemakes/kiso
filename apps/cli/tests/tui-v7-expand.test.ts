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
	/**
	 * DECLARED SUPERSESSION (DC-50 / R14, 2026-09-05) — THERE IS NO
	 * APPENDED BLOCK, so this case asserts what replaces it.
	 *
	 * It was: "ctrl+o on a tool from three turns back APPENDS the expanded
	 * block — the rows above it byte-identical (the work order's
	 * done-when)". Every needle in it was the block's addressing —
	 * `shell seq 1 8 · expanded · 2 turns back`, the `--- shell input ---`
	 * section headers — which existed so a copy printed far from its call
	 * could say which call it was a copy of. Amendment 1 removes the copy:
	 * the card is re-rendered where the call stands.
	 *
	 * THE DONE-WHEN MOVED, and honestly rather than quietly. "The rows
	 * above are byte-identical" was a claim about an APPEND, and it needs
	 * a screen where the block fits and nothing scrolls to mean anything
	 * — which is why the H=200 version of it was withdrawn from 0.24.2 and
	 * carried into this round (route-b-carried-items #1). Its route-B form
	 * is a ROUND TRIP — collapse, expand, collapse, and the rows above are
	 * reproduced — and it is gated at H=200 in
	 * `packages/tui/tests/r14-global-expand.test.ts`, with the non-vacuity
	 * guard the carried item insisted on. On this 24-row terminal the
	 * expanded body is taller than the screen, so two viewports holding
	 * different parts of one session would say nothing about whether
	 * anything was rewritten — the same reason the original was withdrawn.
	 *
	 * What this case keeps is what only a real PTY can show: the key,
	 * pressed for real, reaches the whole of a settled call's output.
	 */
	it("COMMITTED: ctrl+o expands a tool from three turns back IN PLACE — its whole output, and the way back", () => {
		const { env } = isolatedEnv();
		// Three turns; the FIRST's shell (`seq 1 8`) settles into the 5-row
		// tail with the ctrl+o affordance and freezes; turns 2-3 are
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
				["\u258c ", "go\r"], // the brick — the startup paint is race-proof in BOTH modes
				["built.", "go\r"], // turn 1's response → turn 2
				["second turn.", "go\r"], // turn 2's response → turn 3
				["third turn.", "\x0f"], // the REAL key — the turn-1 shell has long since frozen
				// THE WAIT NEEDLE IS THE ERASE, not the affordance text. The
				// affordance was tried and the driver hung on it: needles are
				// matched on the RAW stream and the outcome row carries SGR
				// codes inside it, so `ctrl+o collapses` is only contiguous
				// after stripANSI — which is where this case asserts it,
				// below. The erase is contiguous by construction and only
				// the press produces one here (this scenario never resizes).
				["\x1b[2J\x1b[H\x1b[3J", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		expect(out, "the press did not reprint the session").toContain("\x1b[2J\x1b[H\x1b[3J");
		// the WHOLE output of `seq 1 8`, not the settled card's five-row tail
		for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
			expect(clean, `line ${n} of the output is not reachable after the expand`).toMatch(new RegExp(`(^|\\s)${n}(\\s|$)`, "m"));
		}
		expect(clean, "the expanded card does not say how to put it back").toContain("ctrl+o collapses");
		expect(clean, "the addressing text outlived the block it addressed").not.toMatch(/· expanded · \d+ turns? back/);
		expect(out, "the recap's mark is on the expansion").not.toMatch(/✦\x1b\[0m expanded/);
	}, 120_000);

	it("LIVE: the approval panel shows the ALWAYS-verbose diff at the pause (the fold cap + the notice row); a second key on the settled cell EXPANDS it", () => {
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
				// DC-50 / R14: the second key no longer DECLINES. There is no
				// "nothing to expand" any more — the key is a switch, and a
				// settled card obeys it, so the press expands the write's
				// card and the card says how to put it back. The needle is
				// the affordance the new state carries.
				["written.", "\x0f"], // the second key: the cell is settled+committed
				// the ERASE, not the affordance text: needles match the RAW
				// stream and the outcome row that carries `ctrl+o collapses`
				// has SGR codes inside it, so the literal is only contiguous
				// after stripANSI (where it IS asserted, below).
				["\x1b[2J\x1b[H\x1b[3J", "exit\r"],
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
		// DECLARED SUPERSESSION (DC-50 / R14): the second key used to answer
		// with `[nothing to expand]`, because this settled cell was never
		// cut with an affordance and the walk had nothing to open. The key
		// is a switch now — it does not look for a target and cannot
		// decline — so the message is gone with the branch that produced
		// it, and the press reprints with every settled card expanded.
		expect(clean).not.toContain("✦ expanded");
		expect(clean).not.toContain("[nothing to expand]");
		// The press REPRINTED — that is what a switch does, and the erase is
		// the proof of it. What it did NOT do is grow an affordance on this
		// card, and that is correct rather than a miss: this write was
		// refused, so its result is one line, so the card is §7.4's
		// three-row form with nothing between head and outcome to close.
		// A card hiding nothing has no way back to offer.
		expect(out, "the press did not reprint").toContain("\x1b[2J\x1b[H\x1b[3J");
		expect(clean, "a card with no body grew a collapse affordance").not.toContain("ctrl+o collapses");
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
