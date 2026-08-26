/**
 * F4 T7 — the transcript must not glue drafts (PTY).
 *
 * A retryable mid-stream cut voids the draft durably (the kernel gates own
 * that); THIS gate owns the other half: the screen. Pre-F4 the TUI had zero
 * handling for `model_output_abandoned` — `text_delta` appends
 * unconditionally — so a live retry welded the abandoned draft and the
 * retried answer into one block: the durable projection clean, the surface
 * lying (the RD1B-F1 class). The rule: the marker CLOSES the draft with a
 * visible interrupted terminator, and the retried stream opens a fresh
 * block.
 *
 * REAL kiso chat under a real pty, faux provider, a script that cuts once
 * (the new `fail` pseudo-event) and recovers on the retry. Asserted on the
 * pty byte stream (first occurrences follow stream order) AND on the
 * durable log (the marker landed).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def driver(cli, session, env_path, timeout, grace):
    env = json.load(open(env_path))
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, session])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    sent = False
    boot = None
    settled = None
    end = time.time() + timeout
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                break
            full += data
        if not sent and b"kiso" in full:
            if boot is None:
                boot = time.time()
            elif time.time() - boot >= 1.0:
                os.write(fd, b"go\\r")
                sent = True
        if settled is None and b"recovered answer" in full:
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
    sys.stdout.write(full.hex())
    sys.exit(0)

driver(sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]))
`;

describe("F4 T7 — the stream-cut transcript rule", () => {
	it("closes the abandoned draft visibly and opens the retried answer as a fresh block", { timeout: 90_000 }, () => {
		const { dirs, env } = isolatedEnv();
		const work = mkdtempSync(join(tmpdir(), "kiso-f4t7-"));
		const script = [
			{
				events: [
					{ type: "text_start" },
					{ type: "text_delta", text: "the first half of the answer" },
					{ type: "fail", code: "overloaded", status: 529, retryable: true, message: "overloaded" },
				],
			},
			{
				events: [
					{ type: "text_start" },
					{ type: "text_delta", text: "the recovered answer, whole" },
					{ type: "text_end" },
					{ type: "stop", reason: "end_turn" },
				],
			},
		];
		writeFileSync(join(work, "faux.json"), JSON.stringify(script));
		writeFileSync(join(work, "env.json"), JSON.stringify({ ...env, KISO_FAUX_SCRIPT: join(work, "faux.json"), HOME: work }));
		writeFileSync(join(work, "driver.py"), PTY_DRIVER);

		const hex = execFileSync("python3", [join(work, "driver.py"), CLI, "t7f4", join(work, "env.json"), "60", "1.5"], {
			cwd: work,
			encoding: "utf8",
			timeout: 80_000,
		});
		const screen = stripANSI(Buffer.from(hex.trim(), "hex").toString("utf8"));

		// The three beats, in stream order (first occurrences).
		const draft = screen.indexOf("the first half of the answer");
		const closed = screen.indexOf("stream interrupted — the draft above is abandoned");
		const fresh = screen.indexOf("the recovered answer, whole");
		expect(draft, "the draft streamed").toBeGreaterThanOrEqual(0);
		expect(closed, "the interrupted terminator rendered").toBeGreaterThanOrEqual(0);
		expect(fresh, "the retried answer rendered").toBeGreaterThanOrEqual(0);
		expect(draft).toBeLessThan(closed);
		expect(closed).toBeLessThan(fresh);

		// The durable half: the marker landed exactly once, and the log's
		// projection boundary is real — not a screen effect.
		const records = readFileSync(join(dirs.home, "sessions", "t7f4.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: { type: string } });
		expect(records.filter((r) => r.event.type === "model_output_abandoned")).toHaveLength(1);
		expect(records.some((r) => r.event.type === "stop")).toBe(true);
	});
});
