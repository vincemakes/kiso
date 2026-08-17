/**
 * TUI2-R1.5 slice ① — VD-1 on a REAL CLI process, at REAL pacing.
 *
 * R1's own rollup PTY gate (tui2-r1-visibility, T-V2) feeds a burst whose
 * turn has NO text before the tools: the W14 fold-hold keeps every cell
 * live until the next turn's text releases them, they all commit in one
 * frame, and the rollup forms. That is not what a model does. A model
 * SAYS something first — and that text releases the hold, after which
 * each completion commits in its own 16ms frame and the run degrades to
 * one row per call. The walkthrough's frame s1-06 is that degradation.
 *
 * This gate drives the narrated shape and reads the SETTLED SCREEN (the
 * VT emulator, not the byte stream — the byte stream necessarily carries
 * the live per-call rows on its way there). The screen must show the ONE
 * exploration row and none of the individual ones.
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

def driver(cli, args, env, feeds, timeout, cwd):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        if cwd:
            os.chdir(cwd)
        os.execvp("node", ["node", cli] + args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
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

export function ptyRun(args: string[], env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 60, cwd?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-r15-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(args)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout}, ${cwd === undefined ? "None" : JSON.stringify(cwd)})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 180_000, env: process.env });
}

/** The SETTLED screen: the VT grid built from the bytes BEFORE the dock's
 *  teardown (CSI r — the compositor's exit contract byte), so the exit
 *  repaint never erases what the test is looking at. */
export function settledScreen(raw: string, rows = 24, cols = 100): string[] {
	const at = raw.indexOf("\x1b[r");
	const screen = new VtScreen(rows, cols);
	screen.write(Buffer.from(at > 0 ? raw.slice(0, at) : raw, "utf8"));
	return screen.visible();
}

function fauxScript(turns: unknown[]): string {
	const p = join(mkdtempSync(join(tmpdir(), "kiso-faux-")), "faux.json");
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

/** A workspace the burst can really read. */
function workspace(n: number): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ws-"));
	for (let i = 0; i < n; i += 1) writeFileSync(join(dir, `f${i}.txt`), `alpha ${i}\nbeta ${i}\n`, "utf8");
	return dir;
}

describe("TUI2-R1.5 ① — the exploration rollup at real pacing (real CLI)", () => {
	it("a NARRATED burst (text before the tools) still settles as ONE exploration row", () => {
		const ws = workspace(6);
		const events: unknown[] = [{ type: "text_delta", text: "Let me explore the parser area first." }];
		for (let i = 0; i < 6; i += 1) events.push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.txt` } });
		events.push({ type: "tool_call_end", callId: "s0", name: "search_text", input: { pattern: "alpha", path: "." } });
		events.push({ type: "tool_call_end", callId: "l0", name: "list_dir", input: { path: "." } });
		events.push({ type: "stop", reason: "tool_use" });
		const script = fauxScript([{ events }, { events: [{ type: "text_delta", text: "explored." }, { type: "stop", reason: "end_turn" }] }]);
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" });
		const raw = ptyRun(["--mode", "bypass", "r15-roll"], env as NodeJS.ProcessEnv, [["▌ ", "go\r"], ["explored.", "exit\r"]], 60, ws);
		const grid = settledScreen(raw);
		const joined = grid.join("\n");
		// THE settled row — the rollup, formed with no keypress at all
		expect(joined).toMatch(/explored 6 files · 1 search · 1 dir/);
		// …and NOT the eight individual rows the walkthrough saw
		expect(grid.filter((l) => /✓ read {2}f\d\.txt/.test(l))).toHaveLength(0);
		// the affordance is on the row (ctrl+r must have something to do)
		expect(joined).toContain("ctrl+r lists them");
	}, 240_000);
});
