/**
 * UD-1 acceptance criterion 2 — the D13-class case, end to end.
 *
 * A 3,000-line body is pasted (bracketed), collapses to a capsule in
 * the composer, is killed whole by ctrl+u, and comes back with one
 * ctrl+z. The turn then SUBMITS — and the durable log's user turn is
 * byte-exact against the pasted body: the D8 capsule map outlives the
 * buffer, so a draft that died and was undone still expands on the way
 * out. Real CLI under a pty, faux provider.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, argv, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli] + argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    full = b""
    fed = set()
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

function ptyRun(argv: string[], env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 45): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-ud1-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const feedsPath = join(dir, "feeds.json");
	writeFileSync(feedsPath, JSON.stringify(feeds), "utf8");
	const phase = `
import sys, json
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(argv)}, ${JSON.stringify(env)}, json.load(open(${JSON.stringify(feedsPath)})), ${JSON.stringify(workdir)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 110_000, env: process.env });
}

describe("UD-1 — the D13-class paste survives its kill, byte-exact", () => {
	it("paste 3,000 lines, ctrl+u, ctrl+z, submit — the logged turn equals the body", () => {
		const body = Array.from({ length: 3000 }, (_, i) => `line-${String(i + 1).padStart(4, "0")}`).join("\n");
		const dir = mkdtempSync(join(tmpdir(), "kiso-ud1-faux-"));
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "UD1-FAUX-REPLY-DONE" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script });
		const workdir = mkdtempSync(join(tmpdir(), "kiso-ud1-w-"));
		const out = ptyRun(
			["chat", "ud1"],
			env as NodeJS.ProcessEnv,
			[
				["/ commands · \u2191 history", `\x1b[200~${body}\x1b[201~\x15\x1a\r`],
				["UD1-FAUX-REPLY-DONE", "exit\r"],
			],
			workdir,
		);
		expect(out).toContain("UD1-FAUX-REPLY-DONE"); // the turn really ran
		const log = readFileSync(join(dirs.home, "sessions", "ud1.jsonl"), "utf8");
		const userInputs = log
			.split("\n")
			.filter((l) => l.includes('"user_input"'))
			.map((l) => (JSON.parse(l) as { event: { type: string; content: string } }).event)
			.filter((e) => e.type === "user_input");
		expect(userInputs.length).toBe(1);
		const sent = userInputs[0]!.content;
		expect(sent.length).toBe(body.length); // byte-exact: length…
		expect(sent).toBe(body); // …and content
	});
});
