/**
 * The ergonomics batch (0.1.21) — the interactive feel, through the CLI's real PTY:
 *
 *  1. A1: "/compact⏎" — ONE Enter executes the EXACT menu selection
 *     directly (the partial-Enter completes without executing, unit-tested
 *     in the tui package; here the one-Enter path is pinned end to end).
 *  2. A2: ↑ recalls the previous turn into the input row; Enter submits
 *     the recalled line as a real turn (the session runs it).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout, session):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", session])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    idx = 0
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
            while idx < len(feeds) and feeds[idx][0].encode() in full:
                os.write(fd, feeds[idx][1].encode())
                idx += 1
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

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, session: string, timeout = 45): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-feel-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout}, ${JSON.stringify(session)})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

/** Seed a LONG session (7 chunky rounds + an open final input — the crash
 *  shape, so chat's recovery resumes it first). The result size and round
 *  count are tunable for the C8 auto-compact shape (a session that crosses
 *  the ~ctx threshold). */
function seedSession(home: string, id: string, opts: { rounds?: number; resultChars?: number } = {}): void {
	const rounds = opts.rounds ?? 7;
	const resultChars = opts.resultChars ?? 1500;
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	let seq = 0;
	const lines: string[] = [];
	const push = (event: Record<string, unknown>): void => {
		lines.push(JSON.stringify({ runId: "r1", ts: seq, event: { seq, ...event } }));
		seq += 1;
	};
	push({ type: "user_input", content: "start" });
	for (let i = 0; i < rounds; i++) {
		push({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		push({ type: "tool_result", callId: `r${i}`, content: "x".repeat(resultChars), isError: false });
		push({ type: "user_input", content: `t${i}` });
	}
	writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
}

describe("A1: the menu Enter executes the EXACT selection directly", () => {
	it('typing "/compact" and pressing Enter ONCE runs the command', () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-feel-a1-"));
		const { env: isoEnv, dirs } = isolatedEnv();
		seedSession(dirs.home, "f1");
		// fauxSkip = 7: 7 filler + the recovery end_turn + the summary turn.
		const script = [
			...Array.from({ length: 7 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] })),
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "The covered rounds, summarized." }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");

		const out = ptyRun(
			{ ...isoEnv, KISO_FAUX_SCRIPT: scriptPath },
			[
				// ONE feed: the full "/compact" + one Enter. The recovery's
				// prompt is the trigger — the line is queued and dispatched
				// after it, exactly one Enter total.
				["▌ ", "/compact\n"],
				// W18 re-baseline: the settled notice is the RECAP — the ▞
				// glyph is unique to it (the live row uses ▘).
				["[/compact] ▞ compacted", "exit\n"],
			],
			dir,
			"f1",
		);
		expect(stripANSI(out)).toContain("[/compact] ▞ compacted ·"); // the recap
		const durable = readFileSync(join(dirs.home, "sessions", "f1.jsonl"), "utf8");
		expect(durable).toContain('"type":"summarized"');
	});
});

describe("A2: ↑↓ recall the session history", () => {
	it("↑ recalls the previous turn into the input row; Enter resubmits it as a real turn", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-feel-a2-"));
		const { env: isoEnv } = isolatedEnv();
		const script = [
			{ events: [{ type: "text_delta", text: "first answer" }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "second answer" }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");

		const out = ptyRun(
			{ ...isoEnv, KISO_FAUX_SCRIPT: scriptPath },
			[
				// The fresh session — the first prompt is live (no recovery).
				// "hello" typed WITHOUT the Enter first, so the recall's
				// SECOND "hello" in the input row is distinguishable.
				["▌ ", "hello"],
				["hello", "\r"], // the first turn submits
				["first answer", "\x1b[A"], // ↑ — the history recalls "hello"
				// v6: the resubmit fires on the IDLE STATUS (the post-turn
				// paintIdle) — the recalled row is byte-identical to the typed
				// one, so a "hello" needle would fire at the TYPED row again;
				// its bare \r would submit an EMPTY line, which exits the REPL.
				["\x1b[2m▸ default", "\r"], // the recalled line resubmits as a real turn
				["second answer", "exit\n"],
			],
			dir,
			"h2",
		);
		const plain = stripANSI(out);
		expect(plain).toContain("first answer");
		expect(plain).toContain("second answer"); // the recalled "hello" ran again
		// v6: the frames coalesce at 16ms — the ↑ and the immediate Enter
		// land in ONE frame, so the recalled row's render merges with the
		// submit; the recall's proof is the RESUBMITTED turn above. The
		// typed row rendered (the "hello" needle waited for it).
		expect((plain.match(/› hello/g) ?? []).length).toBeGreaterThanOrEqual(1);
	});
});

describe("C8: /compact auto-trigger (opt-in via KISO_AUTO_COMPACT)", () => {
	it("after the turn ends, a ~ctx ratio over the threshold runs the /compact FULL path — the notice + a durable summarized event", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-feel-c8-"));
		const { env: isoEnv, dirs } = isolatedEnv();
		// The shape: 5 chunky reads (130K chars each). The recovery's
		// continuation microcompacts r0 (the newest 4 stay — ~520K chars ≈
		// 0.65 of the 200K window — under the 0.7 trigger, so the recovery
		// does NOT trigger). The live turn then adds 50K chars of MODEL
		// TEXT (assistant text is never compactable and displaces nothing):
		// the post-turn ratio ≈ 0.71 crosses the threshold, and the
		// auto-trigger fires AFTER the turn — WITHOUT the human typing
		// /compact. (A tool RESULT would not work: tool results cap at
		// OUTPUT_CAP = 100K chars, and the microcompact's kept window
		// would displace a seed result with the smaller read.)
		seedSession(dirs.home, "c8", { rounds: 5, resultChars: 130_000 });
		// fauxSkip = 5 (the seed's results; no stops in the seed): 5 fillers
		// + the recovery's end_turn + the live long-text answer + the auto
		// summary.
		const script = [
			...Array.from({ length: 5 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] })),
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "a".repeat(50_000) }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "The covered rounds, summarized." }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");

		const out = ptyRun(
			{ ...isoEnv, KISO_AUTO_COMPACT: "0.7", KISO_FAUX_SCRIPT: scriptPath },
			[
				// ONE turn ("go") — the auto-trigger then fires WITHOUT any
				// /compact keystroke; the recap is the auto notice.
				["▌ ", "go\n"],
				["[/compact] ▞ compacted", "exit\n"],
			],
			dir,
			"c8",
		);
		expect(stripANSI(out)).toContain("[/compact] ▞ compacted ·"); // the auto notice
		const durable = readFileSync(join(dirs.home, "sessions", "c8.jsonl"), "utf8");
		expect(durable).toContain('"type":"summarized"'); // the durable /compact fact
	});

	it("PIPE mode: the auto-trigger still completes — the exit must await the appended /compact segment", () => {
		// The published-artifact probe found the race: in pipe mode EOF
		// closes the input early, so the exit-time `await chain` captured
		// the chain BEFORE the turn's auto-compact append — the summarize
		// never ran. The exit re-await covers it. This pins the pipe shape.
		const dir = mkdtempSync(join(tmpdir(), "kiso-feel-c8pipe-"));
		const { env: isoEnv, dirs } = isolatedEnv();
		seedSession(dirs.home, "c8pipe", { rounds: 5, resultChars: 130_000 });
		const script = [
			...Array.from({ length: 5 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] })),
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "a".repeat(50_000) }, { type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "The covered rounds, summarized." }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");

		const out = execFileSync(
			"node",
			[CLI, "chat", "c8pipe"],
			{ encoding: "utf8", timeout: 90_000, input: "go\n", env: { ...isoEnv, KISO_AUTO_COMPACT: "0.7", KISO_FAUX_SCRIPT: scriptPath } },
		);
		expect(stripANSI(out)).toContain("[/compact] ▞ compacted ·"); // W18: the recap
		const durable = readFileSync(join(dirs.home, "sessions", "c8pipe.jsonl"), "utf8");
		expect(durable).toContain('"type":"summarized"');
	});
});
