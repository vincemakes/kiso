/**
 * TUI2-R1.5 slice ④ — VD-4 + VD-5 on a real CLI, at real pacing.
 *
 * The unit pins the shapes; this pins the session. A shell that runs for
 * six seconds is watched WHILE it runs (the clean header, the moving
 * tail) and read again after it settles (one row), and the key that the
 * settled row advertises is pressed.
 *
 * The pipe path carries no compositor at all and must be untouched by
 * any of it — asserted here, per the round's `pipe` proof line.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, screenAt, settledScreen, spares } from "./helpers/pty.js";

/** A workspace whose shell script paces its own output. */
function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	writeFileSync(join(dir, "steps.sh"), 'for i in 1 2 3 4 5 6; do echo "step $i of six"; sleep 0.4; done\n', "utf8");
	return dir;
}

const COMMAND = "sh steps.sh";

function shellTurns(): unknown[] {
	return [
		{ events: [{ type: "tool_call_end", callId: "c1", name: "shell", input: { command: COMMAND } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "ran it." }, { type: "stop", reason: "end_turn" }] },
		...spares(),
	];
}

describe("TUI2-R1.5 ④ — the shell card on a real PTY", () => {
	it("RUNNING: the header is the clean command with its own duration, and the first tail row is real output", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(shellTurns()), KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-sh-run"], env as NodeJS.ProcessEnv, {
			feeds: [
				["▌ ", "go\r"],
				["ran it.", "exit\r"],
			],
			cwd: ws,
		});
		// the frame while the command was still running.
		// NEEDLE MOVED TWICE. First (R9 P2 / D4): "step 2 of six" used to
		// exist only in the live tail, because a settled shell showed no
		// output at all — it appears in the settled card too now, so it
		// picks the wrong moment. Then (DC-46): the live-tail FOOTER that
		// replaced it is gone as well — its two gestures moved onto the
		// status row rather than spending a window row. That row is the
		// needle now, and it is still the one string that exists only
		// while the call is running: the settle rewrites it in place as
		// `exit 0 · N lines · Ns`.
		const grid = screenAt(raw, "esc stops · alt+⏎ redirects");
		const joined = grid.join("\n");
		expect(joined).not.toContain('{"command"');
		// MOVED (R13 E2): the elapsed left the running head row for the
		// card's METADATA row, which is where the settled card keeps it — so
		// the settle changes what a row says and never where it sits. VD-4's
		// subject (the duration is its own segment, never welded to a cut
		// word) is unchanged and holds on that row.
		expect(joined).toMatch(/shell sh steps\.sh/);
		// DC-46: the status row carries the elapsed AND the two gestures.
		expect(joined).toMatch(/\n\s+\d+s · esc stops/);
		// the tail is live and its first row is never a BARE GUTTER — VD-4's
		// subject, and this case's.
		//
		// AMENDED (DC-46): the live window is the settled window now, so it
		// carries the same cut note when the output outruns the cap, and
		// `openBlock` puts the corner on that note — the block's first row.
		// So the row after the head is output OR the note, never blank, and
		// a real output row follows it immediately.
		const first = grid.findIndex((l) => l.startsWith("  \u2514 "));
		expect(first).toBeGreaterThan(0);
		expect(grid[first], "the block opens on a bare gutter").toMatch(/ {2}\u2514 (?:step \d of six|… \d+ earlier lines? · ctrl\+o expands)/);
		expect(grid.slice(first, first + 2).some((l) => / {2}\u2514 step \d of six| {4}step \d of six/.test(l)), "no real output row in the live window").toBe(true);
	}, 240_000);

	it("SETTLED: the shell is a SLAB — its tail is on screen and the note names the key", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(shellTurns()), KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-sh-settle"], env as NodeJS.ProcessEnv, {
			feeds: [
				["\u258c ", "go\r"],
				["ran it.", "exit\r"],
			],
			cwd: ws,
		});
		const grid = settledScreen(raw);
		// R2 (law 1.3 — no empty marks): the settled row carries NO tick.
		// A row that already says `exit 0` does not also need a symbol
		// saying it went fine, and the gutter is two spaces now.
		const head = grid.findIndex((l) => /^ {2}shell /.test(l));
		expect(head, "no settled shell row on the screen").toBeGreaterThan(0);
		expect(grid[head]).not.toContain("\u2713"); // the tick is retired, not moved
		// DECLARED REVERSAL (R9 P2 / D4): the head row names the command
		// and nothing else; the KEY moved to the slab's note row, which is
		// where the content stops. One affordance for the cell, still.
		expect(grid.join("\n")).toContain("ctrl+o expands");
		expect(grid[head]).not.toContain("ctrl+o");
		// nothing of the output is on the screen, and no cut row survives
		expect(grid[head + 1] ?? "").not.toMatch(/^\u2502 step/);
		expect(grid.join("")).not.toContain("earlier rows"); // the pre-slab wording
		expect(grid.join("\n"), "the tail is back, inside the slab").toMatch(/step 6 of six/);
		expect(grid.join("\n")).not.toMatch(/^\u2502 step \d of six/m);
	}, 240_000);

	it("ctrl+o EXPANDS the settled shell — the whole output, plus the way back", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(shellTurns()), KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-sh-expand"], env as NodeJS.ProcessEnv, {
			feeds: [
				["\u258c ", "go\r"],
				["ran it.", "\x0f"],
			],
			delays: [[7, "exit\r"]],
			cwd: ws,
		});
		// DECLARED SUPERSESSION (DC-50 / R14, 2026-09-05) — THE SETTLED
		// CELL TOGGLES IN PLACE NOW.
		//
		// This case said "a COMMITTED cell never toggles in place (history
		// is never rewritten, ADR-0046) — the key appends the expanded
		// block instead, and names what it aimed at", and its own comment
		// pointed at DC-50 for the cost of that: an uncapped block appended
		// to a 24-row terminal pushes its own head off the top, which is
		// why the head row had to be asserted on the raw stream rather than
		// on the screen.
		//
		// Amendment 1 removes the premise. The card is re-rendered where
		// the call stands, so there is no copy to name its original —
		// `expanded · N turns back` was addressing for a block printed far
		// from its card, and it retires with the block. What survives is
		// the capability, and it is asserted where a reader would look for
		// it: the whole output is reachable, and the card says how to put
		// it back.
		const plainRaw = raw.replace(/\x1b\[[0-9;]*m/g, "");
		expect(raw, "the press did not reprint").toContain("\x1b[2J\x1b[H\x1b[3J");
		// the WHOLE output, not the five-line preview the settled card cuts to
		for (const n of [1, 3, 6]) {
			expect(plainRaw, `step ${n} of the output is not reachable after the expand`).toContain(`step ${n} of six`);
		}
		expect(plainRaw, "the expanded card does not say how to collapse").toContain("ctrl+o collapses");
		expect(raw, "the recap's mark is on the expansion").not.toMatch(/✦\x1b\[0m expanded|✦ expanded/);
	}, 240_000);

	it("THE PIPE PATH is untouched — no compositor, no tail, no affordance, the result in full", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(shellTurns()), KISO_MODE: "bypass" });
		const res = runCli(["--mode", "bypass", "r15-sh-pipe"], env as NodeJS.ProcessEnv, { input: "go\nexit\n", cwd: ws, timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		const out = stripANSI(res.stdout);
		expect(out).toContain("✓ shell sh steps.sh (exit 0)");
		expect(out).not.toContain("ctrl+o");
		expect(out).not.toContain("live tail");
		expect(out).not.toContain("│ ");
		// the result itself still reaches a pipe consumer, in full
		expect(out).toContain("step 1 of six");
		expect(out).toContain("step 6 of six");
	}, 240_000);
});
