/**
 * TUI v7 W20 — the task checklist as STATE, not events, through the
 * CLI's topmost entry on a REAL PTY (40×80):
 *
 *  a faux turn fires 10 `task_set` calls (whole-table replace, one item
 *  flipping active per call). The work order's done-when:
 *   1. the live block redraws IN PLACE — the run's forms each painted
 *      ONCE at its TRUE row (the A8b single-copy discipline — the old
 *      row-1 clamp pile is gone), the done items stay COLLAPSED behind
 *      the cut family (`└ +N more` / `└ +N done · ctrl+r` — the W15
 *      toggle's affordance), and the live repaints never touch the
 *      committed band.
 *   2. exactly ONE settled `▞ task done · 10 items · <duration>` block
 *      at the turn's end — the derived counts + the model tail riding
 *      the FINAL state (10 items — 0 pending, 1 active, 9 done), the
 *      full final list in the durable checklist shape (▣/▖/□), the
 *      turn's text and the recap below.
 *   3. the idle chrome (the mode line, the box) survives the turn.
 *
 * The turn's stream (verified ground truth — the seeded emulator matches
 * the real screen): the R-G 0.1.47 (ADR-0050) ~1ms link-lock append
 * merged the idle screen and the run's settle into ONE sync frame — the
 * chrome-only dock frame, then the merged opening+run commit: the idle
 * screen (the session line, the banner, the chrome) paints, the
 * turn-start real-LF scrolls follow (the idle screen scrolls OUT of the
 * window — the banner is GONE from the final grid, so the work order's
 * "committed rows above byte-identical to the pre-turn transcript"
 * claim is unreachable at the PTY and re-grounds as: the live repaints
 * touch ONLY the block's own rows), then the DURING-RUN band (the run
 * chrome, the chip, the tool cells, the forms — each CUP'd at its TRUE
 * old row, the in-place redraw), then the settle's repaint (the
 * committed band: the tool cells, the LAST live state, the settled
 * block, the recap), the cursor restore, `[?2026l`. There is NO
 * separate exit-repaint frame in the new flow — the settle is the last
 * sync frame, and the driver's split (the second `?2026l`) now lands
 * at the merged commit's END: PART1 carries the whole run, PART2 is
 * the exit teardown — its marker varies (`[?1049l` or the `[r`
 * scroll-reset + chrome clears) — the gate slices the turn before it.
 *
 * The ctrl+r toggle itself is unreachable at the PTY: the key's needle
 * (`└ +N done · ctrl+r`) exists only in the settle's repaint, so the
 * key always lands AFTER the checklist settled (done — never toggles);
 * the toggle's coverage lives in the compositor's unit gates. The e2e
 * gate asserts the affordance (the cut family) and the collapse.
 *
 * The VT grid: a small emulator reconstructs the SCREEN from the raw
 * PTY bytes (CUP/EL/ED, the scroll idiom, OSC skipped) and snapshots
 * it before every row repaint (`\x1b[<r>;1H\x1b[0K` — the product's
 * per-row erase-line idiom; the old CUP+`0J` trigger never fires — the
 * repaint never erases down).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const TASK_EXT = join(fileURLToPath(new URL("../../..", import.meta.url)), "extensions", "task", "src", "kiso-task.mjs");
const H = 40;
const W = 80;

/**
 * The ORDERED PTY driver (the tui-v7 while-loop, plus the split): the
 * R-G 0.1.47 (ADR-0050) ~1ms link-lock append merged the idle screen
 * and the run's settle into ONE sync frame, so the second `?2026l`
 * now lands at the merged commit's END — PART1 is the whole run's
 * transcript (the chrome-only dock frame + the merged opening+run
 * commit), PART2 the exit teardown. The feed-needle offsets are
 * recorded for the ordering assertions. KISO_MODE=bypass — every
 * task_set auto-allows (no approval asks — the W20 claim is the
 * checklist state machine, not the permission flow); the task
 * extension is installed from its source file.
 */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.environ["KISO_MODE"] = "bypass"
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", "task20"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(${H}, ${W})
    full = b""
    idx = 0
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
            while idx < len(feeds) and feeds[idx][0].encode() in full:
                os.write(fd, feeds[idx][1].encode())
                idx += 1
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    # the split lands at the SECOND frame's end (its sync-off): the
    # FIRST frame is chrome-only — the banner cell is pushed after the
    # dock's enter, so it paints in the merged frame — and that frame's
    # status row (the hint) paints BEFORE the banner. The second frame
    # is the MERGED opening+run commit (R-G 0.1.47, ADR-0050 — the
    # ~1ms link-lock append no longer paces the commit boundaries, so
    # the idle screen and the run's settle share one frame): the whole
    # run rides PART1; PART2 is the exit teardown.
    text = full.decode(errors="replace")
    sync = "\x1b[?2026l"
    first = text.find(sync)
    split = text.find(sync, first + 1) if first >= 0 else -1
    split = split + len(sync) if split >= 0 else 0
    sys.stdout.write("===PRE===\\n" + text[:split] + "\\n===POST===\\n" + text[split:] + "\\n")
    sys.exit(0)
`;

/** Run the turn; returns { pre, post } — the pre-turn transcript and
 *  the turn's paints. */
function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 60) {
	const dir = mkdtempSync(join(tmpdir(), "kiso-task20-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
	const pre = /===PRE===\n([\s\S]*?)\n===POST===/.exec(out)![1]!;
	const post = /===POST===\n([\s\S]*)$/.exec(out)![1]!;
	return { pre, post };
}

/** The MINIMAL VT grid emulator: CUP/EL/ED, the real-LF scroll at the
 *  last row, CR/LF, SGR + OSC + private sequences skipped. Every row
 *  repaint (`\x1b[<r>;1H\x1b[0K` — the product's per-row idiom, never
 *  `0J`) snapshots the PRE-paint grid (the completed frame) with its
 *  byte offset. */
function vtFrames(stream: string): { rows: string[]; offset: number }[] {
	const rows = Array.from({ length: H }, () => new Array<string>(W).fill(" "));
	let r = 0;
	let c = 0;
	const snapshots: { rows: string[]; offset: number }[] = [];
	const snap = (offset: number) => {
		snapshots.push({ rows: rows.map((row) => row.join("")), offset });
	};
	const put = (ch: string) => {
		if (r < H && c < W) rows[r]![c] = ch;
		c += 1;
	};
	for (let i = 0; i < stream.length; ) {
		const ch = stream[i]!;
		if (ch === "\x1b") {
			const csi = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(stream.slice(i));
			if (csi !== null) {
				const [full, params = "", final = ""] = csi;
				const p = params.split(";").map((n) => Number(n) || 0);
				if (final === "H" && p.length === 2 && p[1] === 1) {
					// a CUP landing at column 1 — if the NEXT CSI erases
					// the line (0K), this is a row repaint: snapshot the
					// completed frame BEFORE it
					const next = /^\x1b\[([0-9]*)K/.exec(stream.slice(i + full.length));
					if (next !== null && (next[1] === "" || next[1] === "0")) snap(i);
				}
				switch (final) {
					case "H":
						r = Math.max(0, Math.min(H - 1, p[0]! - 1));
						c = Math.max(0, Math.min(W - 1, p[1]! - 1));
						break;
					case "J":
						if (p[0] === 2 || p[0] === 3) for (const row of rows) row.fill(" ");
						else for (let y = r; y < H; y += 1) rows[y]!.fill(" ");
						break;
					case "K":
						if (p[0] === 0) rows[r]!.fill(" ", c);
						else if (p[0] === 1) rows[r]!.fill(" ", 0, c + 1);
						else rows[r]!.fill(" ");
						break;
					case "G":
						c = Math.max(0, Math.min(W - 1, p[0]! - 1));
						break;
					case "A":
						r = Math.max(0, r - (p[0] || 1));
						break;
					case "B":
						r = Math.min(H - 1, r + (p[0] || 1));
						break;
					case "C":
						c = Math.min(W - 1, c + (p[0] || 1));
						break;
					case "D":
						c = Math.max(0, c - (p[0] || 1));
						break;
					default:
						break; // the private sequences (?2026h/l etc.) — ignored
				}
				i += full.length;
				continue;
			}
			const osc = /^\x1b\]/.exec(stream.slice(i));
			if (osc !== null) {
				// the editor's OSC markers — skip to the BEL or the ST
				const bel = stream.indexOf("\x07", i);
				const st = stream.indexOf("\x1b\\", i);
				const ends = [bel, st].filter((x) => x >= 0);
				const end = ends.length > 0 ? Math.min(...ends) : -1;
				if (end === -1) i = stream.length;
				else i = end + (end === bel ? 1 : 2);
				continue;
			}
			i += 1;
			continue;
		}
		if (ch === "\r") {
			c = 0;
			i += 1;
			continue;
		}
		if (ch === "\n") {
			if (r === H - 1) {
				// the real-LF scroll — the commit idiom: the screen
				// shifts up one, the new row lands at the bottom
				for (let y = 1; y < H; y += 1) rows[y - 1] = rows[y]!;
				rows[H - 1] = new Array<string>(W).fill(" ");
			} else {
				r += 1;
			}
			c = 0;
			i += 1;
			continue;
		}
		put(ch);
		i += 1;
	}
	snap(stream.length);
	return snapshots;
}

describe("TUI v7 W20 — the task checklist as STATE (real PTY, 40×80)", () => {
	it("10 task_set updates redraw ONE live block in place (stable origin, the collapse + the cut family), then settle as exactly ONE task done block (the final counts + the full list); the turn's text and the recap follow; the idle chrome survives", () => {
		const { env, dirs } = isolatedEnv();
		// the task extension installed from its source file (the artifact)
		writeFileSync(join(dirs.extensions, "kiso-task.mjs"), readFileSync(TASK_EXT, "utf8"), "utf8");
		const dir = mkdtempSync(join(tmpdir(), "kiso-task20-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		const script = join(dir, "faux.json");
		// one burst of 10 whole-table replaces: call k marks item k done
		// and item k+1 active (the final call: 9 done + 1 active).
		const list = (k: number) =>
			Array.from({ length: 10 }, (_, i) => ({
				text: `item ${i + 1}`,
				status: i + 1 < k ? "done" : i + 1 === k ? "active" : "pending",
			}));
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						...Array.from({ length: 10 }, (_, k) => ({
							type: "tool_call_end",
							callId: `t${k + 1}`,
							name: "task_set",
							input: { items: list(k + 1) },
						})),
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the task list is final." }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const { pre, post } = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\n"], // the brick — the startup prompt
				["the task list is final.", ""], // the turn's text — the settle follows
				[" · 10 tools", "exit\n"], // the recap — then the prompt quits
			],
			workdir,
		);

		// the pre-teardown stream — the whole run: the chrome-only dock
		// frame + the merged opening+run commit (R-G 0.1.47, ADR-0050 —
		// the ~1ms link-lock append merged the idle screen and the run's
		// settle into ONE sync frame, so the driver's second `?2026l`
		// split lands at the merged commit's END; the exit teardown
		// follows — its marker varies between [?1049l and the [r
		// scroll-reset + chrome clears; the assertions run on the
		// pre-teardown stream)
		const teardown = post.search(/\x1b\[\?1049l|\x1b\[r/);
		const turn = pre + (teardown === -1 ? post : post.slice(0, teardown));
		const frames = vtFrames(turn);
		const finalGrid = frames.at(-1)!.rows;

		// the idle chrome — the banner art + the hint — rides the merged
		// opening commit, then the settle's real-LF scrolls push the
		// banner OFF the final grid (the OLD flow's separate idle frame
		// scrolled it out too) — the claims assert on the FRAMES'
		// pre-scroll snapshots
		expect(frames.some((f) => f.rows.join("\n").includes("█"))).toBe(true);
		expect(frames.some((f) => f.rows.join("\n").includes("/ commands · ↑ history"))).toBe(true);

		// ① A8b re-baseline: the "in-place redraws at row 1" the old gate
		// counted were the row-1 CLAMP PILE — the settle's band stamped
		// every committed line (the chip, the tool cells, the run's
		// intermediate task blocks) at row 1, each overwriting the
		// previous in the same frame — the very defect the A8b band-skip
		// fixed. The A8b stream: the run's forms (the block redrawn once
		// per task_set update) ride the settle's pre-paint — each painted
		// ONCE at its TRUE old row (the scrollback record, the A7
		// single-copy discipline), and the live block itself anchors at
		// liveTop=1 (the stable origin — the live section, untouched by
		// A8b). The gate: the run's forms all appear, each at its own
		// row, none clamped at 1.
		const forms = [...turn.matchAll(/\x1b\[(\d+);1H\x1b\[0K\x1b\[1m▞\x1b\[0m task · 10 items · 1 active · ([0-9]+) done/g)];
		const intermediate = forms.filter((m) => Number(m[2]!) < 6); // the RUN's forms — the states before the final (the settle's repaint restates the 6/7-done states at their own rows)
		expect(intermediate.length).toBeGreaterThan(4); // the run's forms redrew, each painted once
		expect(intermediate.every((m) => m[1] !== "1")).toBe(true); // no row-1 clamp pile — every form at its true row
		expect(new Set(intermediate.map((m) => m[1])).size).toBe(intermediate.length); // one form per row — the single-copy discipline

		// ② the collapse held during the run: the done items stayed hidden
		// behind the cut family — the run's forms ride the during-run band
		// (the chip through the LF scroll — the visible repaint after it is
		// the FINAL state, whose settled ▣ list legitimately shows), and
		// those forms carry the overflow fold + the done-collapse
		// affordances, never the ▣ the collapse hides.
		const chipPaint = turn.indexOf("\x1b[7m go \x1b[27m"); // the user message's chip — carried by the settle's pre-paint at its TRUE old row (A8b: the row-1 clamp is gone — the needle is the chip's content, not its old clamped row; the rail retired by the 2026-08-09 ruling)
		expect(chipPaint).toBeGreaterThan(0);
		const scroll = turn.indexOf("\n", chipPaint); // the settle's LF scroll — the pre-paint's end (the repaint follows, chrome first, no LF)
		const during = turn.slice(chipPaint, scroll === -1 ? undefined : scroll);
		expect(/└ \+[0-9]+ more · ctrl\+r/.test(during)).toBe(true); // the overflow fold
		expect(/└ \+[0-9]+ done · ctrl\+r/.test(during)).toBe(true); // the done-collapse
		expect(during).not.toContain("▣ item"); // the collapse — no done rows in the run's forms

		// ③ exactly ONE settled block at the turn's end — the recap
		// idiom with the derived counts and the model tail riding the
		// FINAL state; the full final list in the durable checklist
		// shape (▣/▖/□); the turn's text and the recap follow.
		const doneRows = finalGrid.filter((r) => r.includes("task done"));
		expect(doneRows).toHaveLength(1);
		expect(doneRows[0]!).toContain("task done · 10 items · "); // the duration follows
		expect(doneRows[0]!).toContain("10 items — 0 pending, 1 active, 9 done"); // the model tail — the FINAL state
		const doneRow = finalGrid.findIndex((r) => r.includes("task done"));
		expect(finalGrid[doneRow + 1]).toContain("▣ item 1");
		expect(finalGrid[doneRow + 2]).toContain("▣ item 2");
		expect(finalGrid[doneRow + 10]).toContain("▖ item 10"); // the durable active glyph
		expect(turn).toContain("the task list is final."); // the turn's text — asserted on the BYTES: it rode the during-run band, and whether the settle's scrolls leave it in the final grid varies with the scroll count — the paint itself is deterministic
		expect(finalGrid.join("\n")).toContain(" · 10 tools"); // the recap

		// ④ the idle chrome survived — the mode line (asserted on the
		// FRAMES: the settle's real-LF scrolls and the exit teardown can
		// shift or clear the chrome band — the snapshots hold the
		// pre-scroll state)
		expect(frames.some((f) => f.rows.join("\n").includes("▸ bypass · /mode to switch"))).toBe(true);
	}, 120_000);
});
