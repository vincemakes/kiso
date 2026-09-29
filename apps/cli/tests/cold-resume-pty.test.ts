/**
 * 0.40.0 item 9 — the cold resume, in a real PTY.
 *
 * A session whose last bill put it over the microcompact threshold, billed
 * 30 minutes ago, is resumed: the panel names its size and age, ⏎
 * compacts BEFORE any request, `n` leaves it whole, dontAsk compacts
 * without asking, and a session billed a minute ago is not offered at all.
 * The faux model's window is the 200k fallback, so its threshold is 100k
 * and a 150k bill is over it.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** Keys fed when their needle appears; stop once every feed is sent and
 *  every settle needle is on screen, after a grace window for the writes. */
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
	const dir = mkdtempSync(join(tmpdir(), "kiso-cold-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(argv)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, 25, ${JSON.stringify(settle)}, ${grace})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 45_000, env: process.env });
	return Buffer.from(out, "hex").toString("utf8").replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
}

/** Six finished rounds, the last one billed at 150k, every record stamped
 *  `minutesAgo` in the past — the durable file a resume opens. */
function seed(home: string, id: string, minutesAgo: number): void {
	const ts = Date.now() - minutesAgo * 60_000;
	const lines: string[] = [];
	let seq = 0;
	for (let i = 0; i < 6; i++) {
		const rec = (event: Record<string, unknown>) => lines.push(JSON.stringify({ runId: `run-${i}`, ts, event: { ...event, seq: seq++ } }));
		rec({ type: "user_input", content: `round ${i}: ${"words ".repeat(40)}` });
		rec({ type: "text_delta", text: `answer ${i}` });
		if (i === 5) rec({ type: "usage", inputTokens: 150_000, outputTokens: 900, cacheRead: 149_000, cacheWrite: null, known: true });
		rec({ type: "stop", reason: "end_turn" });
		rec({ type: "terminal", outcome: { kind: "completed" } });
	}
	mkdirSync(join(home, "sessions"), { recursive: true });
	writeFileSync(join(home, "sessions", `${id}.jsonl`), `${lines.join("\n")}\n`);
}

/** The owner's dogfood shape: five finished rounds, then a sixth whose run
 *  was CUT after a tool result — billed at 150k, no terminal. Opening it
 *  resumes that run at once. */
function seedInterrupted(home: string, id: string, minutesAgo: number): void {
	const ts = Date.now() - minutesAgo * 60_000;
	const lines: string[] = [];
	let seq = 0;
	const rec = (runId: string, event: Record<string, unknown>): number => {
		const s = seq++;
		lines.push(JSON.stringify({ runId, ts, event: { ...event, seq: s } }));
		return s;
	};
	for (let i = 0; i < 5; i++) {
		rec(`run-${i}`, { type: "user_input", content: `round ${i}: ${"words ".repeat(40)}` });
		rec(`run-${i}`, { type: "text_delta", text: `answer ${i}` });
		rec(`run-${i}`, { type: "stop", reason: "end_turn" });
		rec(`run-${i}`, { type: "terminal", outcome: { kind: "completed" } });
	}
	rec("run-5", { type: "user_input", content: "round 5: read it" });
	rec("run-5", { type: "usage", inputTokens: 150_000, outputTokens: 900, cacheRead: 149_000, cacheWrite: null, known: true });
	const call = rec("run-5", { type: "tool_call_end", callId: "c5", name: "read_file", input: { path: "a.txt" } });
	rec("run-5", { type: "permission_decided", decisionId: "d-5", callId: "c5", invocationSeq: call, decision: "approved", decidedBy: "mode:bypass" });
	rec("run-5", { type: "stop", reason: "tool_use" });
	rec("run-5", { type: "tool_execution_started", callId: "c5", invocationSeq: call, name: "read_file", input: { path: "a.txt" }, executionId: "ex-5" });
	rec("run-5", { type: "tool_execution_succeeded", executionId: "ex-5", callId: "c5", invocationSeq: call, result: { content: "the file", isError: false } });
	rec("run-5", { type: "tool_result", callId: "c5", invocationSeq: call, content: "the file", isError: false, executionId: "ex-5" });
	mkdirSync(join(home, "sessions"), { recursive: true });
	writeFileSync(join(home, "sessions", `${id}.jsonl`), `${lines.join("\n")}\n`);
}

const VALID_SUMMARY = ["## Goal", "g", "## Constraints", "c", "## User requests", "u", "## Files and changes", "f", "## Errors and fixes", "none", "## Current work", "w", "## Next steps", "n"].join("\n");

/** The faux script resumes at its durable position (six finished rounds):
 *  six spent entries, then the summary call's answer. */
function script(dir: string): string {
	const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
	const p = join(dir, "faux.json");
	writeFileSync(p, JSON.stringify([...Array.from({ length: 6 }, () => say("spent")), say(VALID_SUMMARY)]), "utf8");
	return p;
}

const kinds = (home: string, id: string): string[] =>
	readFileSync(join(home, "sessions", `${id}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => String((JSON.parse(l) as { event: { type: string } }).event.type));

/** Graphite §7.12: on a terminal the compaction is a meta row — its label,
 *  not the pipe's `✦ compacted` sentence, is what reaches the screen. A
 *  settle string that never appears costs the driver its whole 25s wall and
 *  still passes, so this one is named once. */
const COMPACTED = "COMPACTED";

describe("0.40.0 — a resumed session whose cache has gone cold is offered a compaction first", () => {
	it("⏎ compacts before any request; the panel names the size and the age", () => {
		const { env, dirs } = isolatedEnv();
		seed(dirs.home, "cold", 30);
		const screen = pty({ ...env, KISO_FAUX_SCRIPT: script(dirs.home) }, ["chat", "cold"], [["cache is cold", "\r"]], [COMPACTED]);
		expect(screen.replace(/\s+/g, " ")).toContain("this session is 151k tokens, last used 30 min ago, and its cache is cold");
		const k = kinds(dirs.home, "cold");
		expect(k).toContain("summarized");
		expect(k.filter((t) => t === "user_input")).toHaveLength(6); // no new turn was sent
	}, 60_000);

	it("an interrupted run is offered the compaction BEFORE it resumes, and resumes on the compacted history", () => {
		const { env, dirs } = isolatedEnv();
		seedInterrupted(dirs.home, "cut", 30);
		// the durable position is six (five answers, one tool result): the
		// seventh entry answers whichever call comes FIRST — so the order of
		// the summary and the resumed run is what this case observes
		const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
		const p = join(dirs.home, "faux.json");
		writeFileSync(p, JSON.stringify([...Array.from({ length: 6 }, () => say("spent")), say(VALID_SUMMARY), say("resumed after compact")]), "utf8");
		const screen = pty({ ...env, KISO_FAUX_SCRIPT: p }, ["chat", "cut"], [["cache is cold", "\r"]], ["resumed after compact"]);
		expect(screen.replace(/\s+/g, " ")).toMatch(/this session is 15\dk tokens, last used 30 min ago, and its cache is cold/);
		const events = readFileSync(join(dirs.home, "sessions", "cut.jsonl"), "utf8")
			.split("\n")
			.filter((l) => l.trim() !== "")
			.map((l) => (JSON.parse(l) as { event: { type: string; text?: string; outcome?: { kind: string } } }).event);
		const summarized = events.findIndex((e) => e.type === "summarized");
		const resumed = events.findIndex((e) => e.type === "text_delta" && e.text === "resumed after compact");
		expect(summarized, "the compaction landed").toBeGreaterThan(-1);
		expect(resumed, "the run resumed").toBeGreaterThan(summarized);
		expect(events.at(-1)).toMatchObject({ type: "terminal", outcome: { kind: "completed" } });
		// the seeded run's user turn is the only one: nothing new was sent
		expect(events.filter((e) => e.type === "user_input")).toHaveLength(6);
	}, 60_000);

	it("n keeps the full history — nothing is summarized", () => {
		const { env, dirs } = isolatedEnv();
		seed(dirs.home, "keep", 30);
		pty({ ...env, KISO_FAUX_SCRIPT: script(dirs.home) }, ["chat", "keep"], [["cache is cold", "n"]], ["cache is cold"], 3);
		expect(kinds(dirs.home, "keep")).not.toContain("summarized");
	}, 60_000);

	it("dontAsk compacts without a panel — it is not an approval", () => {
		const { env, dirs } = isolatedEnv();
		seed(dirs.home, "unattended", 30);
		const screen = pty({ ...env, KISO_FAUX_SCRIPT: script(dirs.home), KISO_MODE: "dontAsk" }, ["chat", "unattended"], [], [COMPACTED]);
		expect(screen.replace(/\s+/g, " ")).toContain("[dontAsk] this session is 151k tokens");
		expect(screen).not.toContain("keep the full history");
		expect(kinds(dirs.home, "unattended")).toContain("summarized");
	}, 60_000);

	it("a session billed a minute ago is warm — no offer", () => {
		const { env, dirs } = isolatedEnv();
		seed(dirs.home, "warm", 1);
		const screen = pty({ ...env, KISO_FAUX_SCRIPT: script(dirs.home) }, ["chat", "warm"], [], ["/mode to switch"], 3);
		expect(screen).not.toContain("cache is cold");
		expect(kinds(dirs.home, "warm")).not.toContain("summarized");
	}, 60_000);
});
