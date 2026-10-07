/**
 * ADR-0005 Amendment 2 — the retry on a REAL screen (PTY).
 *
 * The unit gates prove the kernel announces a retry before its wait and
 * that the row formatter prints it. Neither proves a person SEES it: the
 * announcement has to cross the hook, the CLI's state, the spinner and the
 * compositor, and a wait of 30 s whose only sign is a moving clock cannot
 * be told apart from a model that is thinking. So this gate runs the real
 * `kiso chat` under a real pty at 80 columns, lets the first request fail
 * with a retryable 429 whose Retry-After holds the wait for 2.5 s, and
 * reads the screen frame by frame as a terminal would have shown it:
 *
 *  - the live row says `↻ retrying 1/10 · rate_limit · next try in 3s`
 *    during the wait (Graphite §8.7: the retry replaces `working`);
 *  - the countdown MOVES on its own (the kernel announces once — the row
 *    recomputes what is left at every repaint);
 *  - at 80 columns the row is composed to fit, whole, and the context
 *    figure, a fact, stays on the status bar through the wait;
 *  - once the retried attempt streams, the row stops saying it is
 *    retrying, and the answer lands;
 *  - the retry is an OBSERVATION: nothing about it is written to the log.
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

// Records every read with its arrival time, so the test can replay the
// stream into a terminal emulator and look at the screen as it was at
// each moment — not only at the end.
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def driver(cli, session, env_path, timeout, grace):
    env = json.load(open(env_path))
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    chunks = []
    full = b""
    sent = False
    boot = None
    settled = None
    t0 = time.time()
    end = t0 + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
            chunks.append([round((time.time() - t0) * 1000), data.hex()])
        if not sent and b"kiso" in full:
            if boot is None:
                boot = time.time()
            elif time.time() - boot >= 1.0:
                os.write(fd, b"go\\r")
                sent = True
        if settled is None and b"the answer after the wait" in full:
            settled = time.time()
        if settled is not None and time.time() - settled >= grace:
            break
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(json.dumps(chunks))
    sys.exit(0)

driver(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]))
`;

describe("ADR-0005 Amendment 2 — a retry you can see", () => {
	it("the row shows the retry, counts it down, fits it to 80 columns, and lets go when the answer streams", { timeout: 90_000 }, () => {
		const { dirs, env } = isolatedEnv();
		const work = mkdtempSync(join(tmpdir(), "kiso-retryrow-"));
		const script = [
			{ events: [{ type: "fail", code: "rate_limit", status: 429, retryable: true, message: "429", retryAfterMs: 2_500 }] },
			{
				events: [
					{ type: "text_start" },
					{ type: "text_delta", text: "the answer after the wait" },
					{ type: "text_end" },
					{ type: "stop", reason: "end_turn" },
				],
			},
		];
		writeFileSync(join(work, "faux.json"), JSON.stringify(script));
		writeFileSync(join(work, "env.json"), JSON.stringify({ ...env, KISO_FAUX_SCRIPT: join(work, "faux.json"), HOME: work }));
		writeFileSync(join(work, "driver.py"), PTY_DRIVER);

		const out = execFileSync("python3", [join(work, "driver.py"), CLI, "retryrow", join(work, "env.json"), "60", "1.5"], {
			cwd: work,
			encoding: "utf8",
			timeout: 80_000,
			maxBuffer: 64 * 1024 * 1024,
		});
		const chunks = JSON.parse(out) as [number, string][];
		expect(chunks.length, "the driver read something").toBeGreaterThan(0);

		// Replay into the emulator; after every read, note the retry row if
		// one is on screen, and the first moment the answer is.
		const emu = new VtScreen(24, 80);
		const retryRows: { at: number; row: string; bar: string }[] = [];
		let answerAt = -1;
		for (const [at, hex] of chunks) {
			emu.write(Buffer.from(hex, "hex"));
			const grid = emu.visible();
			const row = grid.find((r) => r.includes("retrying"));
			if (row !== undefined && retryRows[retryRows.length - 1]?.row !== row) retryRows.push({ at, row: row.trimEnd(), bar: grid[23]! });
			if (answerAt < 0 && grid.some((r) => r.includes("the answer after the wait"))) answerAt = at;
		}
		const seen = retryRows.map((r) => r.row).join("\n");

		// The retry is on screen, with the attempt, the budget, the code, and
		// the wait rounded up: Retry-After 2,500 ms reads "3s".
		// Graphite §8.7: the retry REPLACES `working` on the live row.
		const first = retryRows.findIndex((r) => r.row.includes("↻ retrying 1/10 · rate_limit · next try in 3s"));
		expect(first, `the announced retry on the row\n${seen}`).toBeGreaterThanOrEqual(0);
		// The countdown moves without another announcement.
		const later = retryRows.findIndex((r, i) => i > first && r.row.includes("retrying 1/10 · rate_limit · next try in 1s"));
		expect(later, `the countdown reached 1s on its own\n${seen}`).toBeGreaterThan(first);
		// ...and the row stayed alive while it waited, so a wait never looks
		// like a frozen row. Graphite §8.7: the countdown IS the pulse (the
		// retry's mark is a still `↻`) — every whole second of the wait was
		// on screen.
		for (const s of [3, 2, 1]) expect(retryRows.some((r) => r.row.includes(`next try in ${s}s`)), `${s}s was on the row\n${seen}`).toBe(true);

		// Fitted to 80 columns: the retry's facts stayed whole and its key is
		// the one that applies. Graphite §8.9: the context figure lives on
		// the status bar now, and it stayed there through the wait.
		for (const { row, bar } of retryRows) {
			expect(row, row).toContain("esc gives up");
			expect(row, row).not.toContain("…");
			expect(bar, bar).toMatch(/ctx (\?|[\u2586 ]*\d+%)/);
		}

		// The retried attempt streamed, and the row let go of the retry.
		expect(answerAt, "the answer rendered").toBeGreaterThan(retryRows[retryRows.length - 1]!.at - 1);
		const grid = emu.visible();
		expect(grid.some((r) => r.includes("retrying")), `no retry left on the settled screen\n${grid.join("\n")}`).toBe(false);
		expect(grid.filter((r) => r.includes("the answer after the wait")).length, "the answer, once").toBe(1);

		// An observation, not an event: nothing about the retry was logged.
		const types = readFileSync(join(dirs.home, "sessions", "retryrow.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => (JSON.parse(l) as { event: { type: string } }).event.type);
		expect(types.filter((t) => /retry/i.test(t))).toEqual([]);
		expect(types).toContain("stop");
	});
});
