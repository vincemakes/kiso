/**
 * /fork in a real PTY (owner 2026-11-03: the web app's fork, one rule — after a reply, then switch): the band lists
 * the session's finished replies newest first, the selected one opens on the line it answered, ↓ walks to the older
 * one and ⏎ forks after it. The terminal is then in a session holding that first run only, named "… (fork)", whose
 * sidecar names the parent. A fork calls no model, so the faux script only stands for the two spent rounds.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, argv, env, feeds, timeout, settle, grace):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli] + argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    fed = set()
    end = time.time() + timeout
    settled = None
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
        if settled is None and len(fed) == len(feeds) and all(s.encode() in full for s in settle):
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
`;

function pty(env: NodeJS.ProcessEnv, argv: string[], feeds: [string, string][], settle: string[], grace = 2): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-fork-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(argv)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, 25, ${JSON.stringify(settle)}, ${grace})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 45_000, env: process.env });
	return Buffer.from(out, "hex").toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Two finished rounds: the session /fork is asked of. */
function seed(home: string, id: string): void {
	const ts = Date.now() - 60_000;
	const lines: string[] = [];
	let seq = 0;
	for (const [i, [asked, said]] of [["what does calc.js export?", "It exports add and sub."], ["which one is wrong?", "sub adds instead of subtracting."]].entries()) {
		const rec = (event: Record<string, unknown>) => lines.push(JSON.stringify({ runId: `run-${i}`, ts, event: { ...event, seq: seq++ } }));
		rec({ type: "user_input", content: asked });
		rec({ type: "text_delta", text: said });
		rec({ type: "stop", reason: "end_turn" });
		rec({ type: "terminal", outcome: { kind: "completed" } });
	}
	mkdirSync(join(home, "sessions"), { recursive: true });
	writeFileSync(join(home, "sessions", `${id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("/fork in a real PTY", () => {
	it("lists the replies newest first; the picked one's fork holds its run only, named and linked to its parent", () => {
		const { dirs, env } = isolatedEnv();
		seed(dirs.home, "parent");
		const faux = join(dirs.home, "faux.json");
		const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
		writeFileSync(faux, JSON.stringify([say("It exports add and sub."), say("sub adds instead of subtracting.")]));
		const screen = pty({ ...env, KISO_FAUX_SCRIPT: faux }, ["chat", "parent"], [["sub adds instead", "/fork\r"], ["fork after a reply", "\x1b[B"], ["answered: what does calc.js export?", "\r"]], ["forked"]);
		expect(screen).toContain("fork after a reply");
		expect(screen).toContain("⏎ forks");
		expect(screen).toContain("answered: which one is wrong?");
		const sessions = join(dirs.home, "sessions");
		const fork = readdirSync(sessions).find((f) => f.endsWith(".jsonl") && f !== "parent.jsonl")!.slice(0, -6);
		const events = readFileSync(join(sessions, `${fork}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
		const meta = JSON.parse(readFileSync(join(sessions, `${fork}.meta.json`), "utf8"));
		expect(events.filter((e) => e.type === "terminal")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "terminal", seq: 3 });
		expect(meta.name).toBe("what does calc.js export? (fork)");
		expect(meta.forkedFrom).toMatchObject({ session: "parent", afterSeq: 3 });
	});
});
