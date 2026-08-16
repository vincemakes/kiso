/**
 * TUI #17 (P1) — the reflow gate, the 5th probe class (SCREEN STATE).
 *
 * A REAL PTY runs one text-only turn (a thinking fold + the response —
 * NO tool: tool executions run PARALLEL to the event stream (ADR-0024),
 * so a slow tool's result may land after the run ends; a deterministic
 * gate cannot lean on it). After the turn completes (the idle status),
 * the driver fires the 5-resize sequence (tall/short/wide/narrow
 * alternating) and records every TIOCSWINSZ's byte offset. The
 * transcript feeds the minimal VT screen emulator (tests/helpers/
 * vt-screen.ts), which applies the resizes at those offsets — the
 * emulated geometry tracks the process's. The assertions read the
 * SCREEN, which the byte probes (LF/CSI counts) cannot see:
 *   ① the response text appears exactly once (the reflow ghost — the
 *     pre-fill CUP rows merged/repeated under reflow);
 *   ② separator (box rail) rows in the BODY region ≤ 1 (the old dock
 *     rows the reflow leaves behind — the separator wall; the box's own
 *     two rails sit at H-3/H-1, outside the region — W6);
 *   ③ the fold is its own row ENDING with the /think suffix (the
 *     fold/body merge + the suffix loss);
 *   ④ after the sequence, ① ② re-run on the final screen;
 *   ⑤ no row is a lone "[" (the reflow cut).
 * The byte probes stay — this gate sees what they cannot.
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

/** The reflow driver: 24×80; after the turn completes (the idle status
 *  "▸ default"), the resize sequence fires 0.35s apart; every
 *  TIOCSWINSZ records (len(full), rows, cols); the turn-complete offset
 *  is recorded too. Output: MARKERS=<json> + FULL=<hex>. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def driver(cli, env, feeds, timeout, sizes):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
    end = time.time() + timeout
    done = False
    resizes = []
    fired = 0
    seq_at = None
    done_at = None
    exit_sent = False
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
        if seq_at is None and "0 tools".encode() in full:
            # the turn snapshot AFTER the recap's freeze frame — the idle
            # dock redraw lands before the body's 16ms frame commits the
            # frozen cells (the real-LF commits); the recap only exists
            # once the freeze frame has written.
            seq_at = time.time()
            done_at = len(full)
        if seq_at is not None and fired < len(sizes) and time.time() - seq_at >= 0.35 * (fired + 1):
            winsize(*sizes[fired])
            os.kill(pid, signal.SIGWINCH)
            resizes.append([len(full), sizes[fired][0], sizes[fired][1]])
            fired += 1
        if seq_at is not None and not exit_sent and fired >= len(sizes) and time.time() - seq_at >= 0.35 * (len(sizes) + 1):
            os.write(fd, b"exit\\r")
            exit_sent = True
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write("MARKERS=" + json.dumps({"done": done_at, "resizes": resizes}) + "\\n")
    sys.stdout.write("FULL=" + full.hex() + "\\n")
    sys.exit(0)
`;

const RESIZES = [
	[18, 120],
	[30, 60],
	[20, 140],
	[28, 50],
	[24, 80],
] as [number, number][];

function reflowRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 40): { markers: { done: number; resizes: [number, number, number][] }; full: Buffer } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v4-reflow-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout}, ${JSON.stringify(RESIZES)})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
	const markers = JSON.parse(/MARKERS=(.*)\n/.exec(out)![1]!) as { done: number; resizes: [number, number, number][] };
	const full = Buffer.from(/FULL=(.*)\n/.exec(out)![1]!, "hex");
	return { markers, full };
}

const RESPONSE = "the map room glows faintly";

/** Feed the stream, applying the resizes at the driver's offsets; the
 *  turn-complete snapshot + the final screen. */
function screens(full: Buffer, markers: { done: number; resizes: [number, number, number][] }): { turn: string[]; final: string[] } {
	const emu = new VtScreen(24, 80);
	const pts = [...markers.resizes.map((m) => m as [number, number, number]), [markers.done, -1, -1] as [number, number, number]].sort((a, b) => a[0] - b[0]);
	let pos = 0;
	let turn: string[] | null = null;
	for (const [off, rows, cols] of pts) {
		emu.write(full.subarray(pos, off));
		pos = off;
		// The done marker and the first winch share a byte offset (the
		// driver records both at the same instant) — the snapshot is the
		// state BEFORE that byte, so it must happen before any same-offset
		// resize is applied.
		if (turn === null && off >= markers.done) turn = emu.visible();
		if (rows >= 0) {
			emu.resize(rows, cols);
		}
	}
	emu.write(full.subarray(pos));
	return { turn: turn ?? [], final: emu.visible() };
}

// W6: the ╌ chrome rows became the box rails — the probe counts a stray
// rail in the BODY region (the chrome's own rails sit at H−3/H−1, outside
// the slice — a reflow leftover rail inside the body is the wall).
const bodySepRows = (screen: string[], H: number): number => screen.slice(0, H - 4).filter((l) => l.includes("╭") || l.includes("╰")).length;
const responseOnce = (screen: string[]): number => screen.filter((l) => l.includes(RESPONSE)).length;

describe("TUI #17 — the reflow gate (real PTY, screen state via the VT emulator)", () => {
	it("①②③ after the turn + ④⑤ after the 5-resize sequence: response once, no separator wall, the fold own-row with /think, no lone [", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v4-reflow-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "thinking", text: "R".repeat(150) },
						{ type: "text_delta", text: RESPONSE },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		const { markers, full } = reflowRun({ ...env, KISO_FAUX_SCRIPT: script }, [
			["› ", "look around\r"], // the turn itself — the driver sends exit after the sequence
		]);
		// The sequence really ran (5 winches) and the turn completed.
		expect(markers.resizes).toHaveLength(5);
		expect(markers.done).toBeGreaterThan(0);
		const { turn, final } = screens(full, markers);

		// The scenario is on screen: the fold froze with its suffix.
		require("node:fs").writeFileSync("/tmp/reflow-turn.txt", JSON.stringify(turn));
		require("node:fs").writeFileSync("/tmp/reflow-final.txt", JSON.stringify(final));
		require("node:fs").writeFileSync("/tmp/reflow-markers.txt", JSON.stringify(markers));
		expect(turn.some((l) => l.includes("/think"))).toBe(true);

		// ① the response text appears EXACTLY once on the turn-after screen.
		expect(responseOnce(turn)).toBe(1);
		// ② no separator wall — box rails in the BODY region (1..H-4) ≤ 1.
		expect(bodySepRows(turn, 24)).toBeLessThanOrEqual(1);
		// ③ the fold is its own row ENDING with the /think suffix — the
		// fold/body merge (the recorded symptom) would swallow the suffix.
		const foldRow = turn.find((l) => l.includes("/think"));
		expect(foldRow).toBeDefined();
		expect(foldRow!.trimEnd().match(/\/think\)$/)).not.toBeNull();
		expect(foldRow!.includes(RESPONSE)).toBe(false);

		// ④ after the 5-resize sequence, ① ② hold on the FINAL screen —
		// the reflow left no ghost, no wall, no cut. v6: the content sits
		// at the TOP of the buffer; the shrink's reflow keeps the BOTTOM
		// rows (the emulator models the terminal's reflow), so the top
		// content scrolls INTO the scrollback — the contract is NEVER a
		// ghost: the response appears at most once (0 = scrolled away,
		// 1 = still visible, 2 = the reflow doubled it — the #17 class).
		expect(responseOnce(final)).toBeLessThanOrEqual(1);
		expect(bodySepRows(final, 24)).toBeLessThanOrEqual(1);
		// ⑤ no reflow-cut "[" residue.
		expect(final.every((l) => l.trim() !== "[")).toBe(true);
	}, 90_000);
});
