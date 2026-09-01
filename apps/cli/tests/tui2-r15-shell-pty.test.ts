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
		// the frame while the command was still running
		const grid = screenAt(raw, "step 2 of six");
		const joined = grid.join("\n");
		expect(joined).not.toContain('{"command"');
		expect(joined).toMatch(/shell sh steps\.sh · \d+s/);
		// the tail is live and its first row is output, never a bare gutter
		// R8a: the block's first row is the CORNER row, and it must carry
		// real output — the subject of this case, unchanged.
		const first = grid.findIndex((l) => l.startsWith("  \u2514 "));
		expect(first).toBeGreaterThan(0);
		expect(grid[first]).toMatch(/ {2}\u2514 step \d of six/);
		expect(joined).toContain("live tail · esc stop · alt+⏎ redirect");
	}, 240_000);

	it("SETTLED: the whole shell is ONE row — the output is behind the key", () => {
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
		expect(grid[head]).toContain("ctrl+r expands");
		// nothing of the output is on the screen, and no cut row survives
		expect(grid[head + 1] ?? "").not.toMatch(/^\u2502 step/);
		expect(grid.join("")).not.toContain("earlier rows");
		expect(grid.join("\n")).not.toMatch(/^\u2502 step \d of six/m);
	}, 240_000);

	it("ctrl+r EXPANDS the settled shell — the whole output, plus the way back", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(shellTurns()), KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-sh-expand"], env as NodeJS.ProcessEnv, {
			feeds: [
				["\u258c ", "go\r"],
				["ran it.", "\x12"],
			],
			delays: [[7, "exit\r"]],
			cwd: ws,
		});
		// W15 is unchanged by this round: a COMMITTED cell never toggles in
		// place (history is never rewritten, ADR-0046) — the key appends the
		// expanded block instead, and names what it aimed at. The in-place
		// toggle with its `└ ctrl+r collapses` footer is the LIVE cell's
		// form, pinned in the tui-cells unit.
		const after = settledScreen(raw).join("\n");
		expect(after).toContain("✦ expanded · shell sh steps.sh");
		expect(after).toContain("step 6 of six");
	}, 240_000);

	it("THE PIPE PATH is untouched — no compositor, no tail, no affordance, the result in full", () => {
		const ws = workspace();
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(shellTurns()), KISO_MODE: "bypass" });
		const res = runCli(["--mode", "bypass", "r15-sh-pipe"], env as NodeJS.ProcessEnv, { input: "go\nexit\n", cwd: ws, timeout: 60_000 });
		expect(res.status, res.stderr).toBe(0);
		const out = stripANSI(res.stdout);
		expect(out).toContain("✓ shell sh steps.sh (exit 0)");
		expect(out).not.toContain("ctrl+r");
		expect(out).not.toContain("live tail");
		expect(out).not.toContain("│ ");
		// the result itself still reaches a pipe consumer, in full
		expect(out).toContain("step 1 of six");
		expect(out).toContain("step 6 of six");
	}, 240_000);
});
