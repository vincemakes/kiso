/**
 * 4c — reopening a session replays the durable history into cells (real PTY).
 *
 * A three-turn session is recorded by a real `kiso chat`, then reopened
 * (`kiso chat <id>` — the same show-the-history path `/resume` and
 * `kiso resume <id>` take):
 *   - the last two turns render in full (the committed-cell renderer —
 *     their chips and their replies), the first sits in ONE fold row
 *     naming the viewer's key, and none of its words are on screen;
 *   - ctrl+r opens the viewer, the fold is an entry, and opening it shows
 *     the first turn — the key does what the row says;
 *   - with a compaction, the checkpoint row stands in place of the fold.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** Feeds are [needle, text]: each is typed once its needle has appeared
 *  AFTER the previous feed. Returns the whole output and the offset at
 *  which each feed was typed. */
const DRIVER = `
import os, pty, sys, time, select, struct, fcntl, termios, json
cli, cwd, argv, feeds, rows = sys.argv[1], sys.argv[2], json.loads(sys.argv[4]), json.loads(sys.argv[5]), int(sys.argv[6])
env = json.load(open(sys.argv[3]))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe("node", ["node", cli] + argv, env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, 100, 0, 0))
buf = b""
def pump(t, until=None, after=0):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.02)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            buf += data
        if until is not None and until.encode() in buf[after:]:
            return True
    return until is None
marks = []
ok = True
for needle, text in feeds:
    after = marks[-1] if marks else 0
    if not pump(20, needle, after):
        ok = False
        break
    pump(0.4)
    marks.append(len(buf.decode("utf8", "replace")))  # CHARACTER offsets: the test slices the decoded string
    try:
        os.write(fd, text.encode())
    except OSError:
        ok = False
        break
pump(1.5)
try:
    os.kill(pid, 9)
except ProcessLookupError:
    pass
os.waitpid(pid, 0)
sys.stdout.write(json.dumps({"ok": ok, "marks": marks, "out": buf.decode("utf8", "replace")}))
`;

// OSC strings end in BEL or ST — the window title (which names the
// session by its first ask, legitimately) ends in ST
const strip = (s: string): string => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

function drive(env: NodeJS.ProcessEnv, cwd: string, argv: string[], feeds: [string, string][], rows = 40): { ok: boolean; marks: number[]; out: string } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-4c-"));
	const driver = join(dir, "driver.py");
	writeFileSync(driver, DRIVER, "utf8");
	// the env rides a file: a failed run's message must not print it
	const envFile = join(dir, "env.json");
	writeFileSync(envFile, JSON.stringify(env), "utf8");
	const res = execFileSync("python3", [driver, CLI, cwd, envFile, JSON.stringify(argv), JSON.stringify(feeds), String(rows)], { encoding: "utf8", timeout: 90_000 });
	return JSON.parse(res) as { ok: boolean; marks: number[]; out: string };
}

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

/** A real three-turn session, recorded by `kiso chat`. */
function recordSession(extraTurns: string[] = []): { env: NodeJS.ProcessEnv; cwd: string; home: string } {
	const { env, dirs } = isolatedEnv();
	const cwd = mkdtempSync(join(tmpdir(), "kiso-4c-ws-"));
	mkdirSync(join(cwd, "src"), { recursive: true });
	const asks = ["first question alpha", "second question bravo", "third question charlie", ...extraTurns];
	const script = join(dirs.home, "faux.json");
	writeFileSync(script, JSON.stringify([...asks.map((_, i) => say(`answer number ${i + 1} here`)), say("resumed reply")]), "utf8");
	const envWith = { ...env, KISO_FAUX_SCRIPT: script, TERM: "xterm-256color" };
	const feeds: [string, string][] = [[" · ctx ", `${asks[0]}\r`]]; // Graphite §8.9: the bar's ctx segment (used share) — one plain span, so it matches the raw stream
	for (let i = 1; i < asks.length; i += 1) feeds.push([`answer number ${i} here`, `${asks[i]}\r`]);
	feeds.push([`answer number ${asks.length} here`, "exit\r"]);
	const rec = drive(envWith, cwd, ["chat", "four-c"], feeds);
	expect(rec.ok, "recording the session did not finish").toBe(true);
	return { env: envWith, cwd, home: dirs.home };
}

describe("4c — reopening a session replays the history into cells", () => {
	it("the last two turns in full, the first in ONE fold row; ctrl+r reads it", () => {
		const { env, cwd } = recordSession();
		const run = drive(env, cwd, ["chat", "four-c"], [
			["1 earlier turn · ctrl+r to read", "\x12"], // ctrl+r — open the viewer
			// up (a no-op when the fold is the only entry, so it paints nothing
			// to wait for), then enter opens the entry
			["── transcript ·", "\x1b[A"],
			["", "\r"],
			["first question alpha", "\x1b"], // esc closes
		]);
		expect(run.ok, strip(run.out).slice(-2000)).toBe(true);
		const before = strip(run.out.slice(0, run.marks[0]));
		expect(before).toContain("resuming · 3 turns, showing the last 2");
		expect(before.match(/1 earlier turn · ctrl\+r to read/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
		expect(before).toContain("second question bravo");
		expect(before).toContain("answer number 2 here");
		expect(before).toContain("third question charlie");
		expect(before).toContain("answer number 3 here");
		// the folded turn is NOT on screen — only in the viewer
		expect(before).not.toContain("first question alpha");
		expect(before).not.toContain("answer number 1 here");
		const opened = strip(run.out.slice(run.marks[2]));
		expect(opened).toContain("first question alpha");
		expect(opened).toContain("answer number 1 here");
	}, 180_000);

	it("with a compaction, the checkpoint row stands in place of the fold, and its entry carries the summary", () => {
		const { env, cwd, home } = recordSession(["fourth question delta"]);
		// the compaction a /compact would have written: the first two turns
		// summarized, appended to the durable log as the runtime writes it
		const log = join(home, "sessions", "four-c.jsonl");
		const records = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { runId: string; event: { type: string; seq: number; content?: unknown } });
		const asks = records.filter((r) => r.event.type === "user_input").map((r) => r.event.seq);
		const boundary = asks[2]! - 1; // everything before the third ask
		const last = records[records.length - 1]!;
		appendFileSync(log, `${JSON.stringify({ runId: last.runId, ts: Date.now(), event: { type: "summarized", coversToSeq: boundary, summary: "SUMMARY: alpha and bravo were settled", seq: last.event.seq + 1 } })}\n`);
		const run = drive(env, cwd, ["chat", "four-c"], [
			["checkpoint · summarizes 2 earlier turns · ctrl+r to read", "\x12"],
			["── transcript ·", "\x1b[A"],
			["", "\r"],
			["SUMMARY: alpha and bravo", "\x1b"],
		]);
		expect(run.ok, strip(run.out).slice(-2000)).toBe(true);
		const before = strip(run.out.slice(0, run.marks[0]));
		expect(before).toContain("resuming · 4 turns, showing the last 2");
		expect(before).not.toContain("earlier turn · ctrl+r to read ");
		expect(before).toContain("third question charlie");
		expect(before).toContain("fourth question delta");
		expect(before).not.toContain("first question alpha");
		expect(before).not.toContain("SUMMARY: alpha");
	}, 180_000);
});
