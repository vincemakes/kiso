/**
 * KC3.5 T-Q4 / T-Q5 / T-Q6 — the ask, in real processes.
 *
 * T-Q4 the happy path: the model asks two questions (one single-select,
 *   one multi), the human walks the panel, and ONE durable tool_result
 *   carries the answers JSON — after which the model's next turn runs
 *   and the ordinary chrome (recap, idle status) survives.
 *
 * T-Q5 THE MOAT, the round's crown, on the arc the ① probe proved
 *   rather than the one the spec first imagined: kill -9 mid-panel
 *   leaves the call durable with no result; `kiso resume` meets the
 *   EXISTING uncertainty surface — wearing the ask's own words, because
 *   an interrupted question is not a side effect that may have applied;
 *   the human picks re-ask; the runtime fills its standard result; the
 *   model re-issues ask_user; the panel re-presents; the answer lands
 *   durably; and a SECOND resume never asks again.
 *
 * T-Q6 the races, both orderings.
 *
 * The drivers are settle-and-stop: they read until every asserted
 * outcome is on screen, keep reading for a grace window so the durable
 * writes land, then stop. The timeout is the hang net, never the
 * schedule.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/**
 * The driver: a real PTY, keys fed when their needle appears, and an
 * optional SIGKILL fired the moment a predicate holds on the durable
 * log (the kill9 gate's own shape — the kill lands MID-PANEL, while the
 * execution is started and unreported).
 */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios, json

def durable(home, session):
    try:
        with open(os.path.join(home, "sessions", session + ".jsonl")) as f:
            return [json.loads(l) for l in f if l.strip()]
    except (FileNotFoundError, ValueError):
        return []

def driver(cli, argv, session, env, feeds, timeout, settle, grace, kill_when):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli] + argv)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    full = b""
    fed = set()
    home = env["KISO_HOME"]
    t0 = time.time()
    end = t0 + timeout
    settled = None
    killed = False
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
        for i, (needle, text, delay) in enumerate(feeds):
            if i not in fed and time.time() - t0 >= delay and needle.encode() in full:
                os.write(fd, text.encode())
                fed.add(i)
        # THE KILL: fired when the durable log holds a started ask with no
        # result — the panel is up, the human has not answered, and the
        # process dies where it stands (SIGKILL, no handler, no flush).
        if kill_when is not None and not killed:
            log = durable(home, session)
            started = [r for r in log if r["event"]["type"] == "tool_execution_started"]
            results = [r for r in log if r["event"]["type"] == "tool_result"]
            if len(started) >= 1 and len(results) == 0 and kill_when.encode() in full:
                os.kill(pid, signal.SIGKILL)
                killed = True
                break
        if settled is None and len(fed) == len(feeds) and all(s.encode() in full for s in settle):
            settled = time.time()
        if settled is not None and time.time() - settled >= grace:
            break
    if not killed:
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
`;

interface Rec {
	readonly runId: string;
	readonly event: Record<string, unknown>;
}

function pty(
	env: NodeJS.ProcessEnv,
	argv: string[],
	session: string,
	feeds: [string, string, number][],
	settle: string[],
	opts: { timeout?: number; grace?: number; killWhen?: string | null } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-kc35-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(argv)}, ${JSON.stringify(session)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${opts.timeout ?? 20}, ${JSON.stringify(settle)}, ${opts.grace ?? 2}, ${opts.killWhen === undefined || opts.killWhen === null ? "None" : JSON.stringify(opts.killWhen)})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 45_000, env: process.env });
	return Buffer.from(out, "hex").toString("utf8");
}

function durable(home: string, session: string): Rec[] {
	return readFileSync(join(home, "sessions", `${session}.jsonl`), "utf8")
		.split("\n")
		.filter((l) => l.trim() !== "")
		.map((l) => JSON.parse(l) as Rec);
}

const kinds = (log: Rec[]): string[] => log.map((r) => String(r.event.type));

/** The two questions the round's acceptance names: one single-select,
 *  one multi-select, with descriptions. */
const QUESTIONS = [
	{
		question: "which bundler?",
		header: "bundler",
		options: [
			{ label: "vite", description: "fast dev server" },
			{ label: "esbuild", description: "one binary" },
		],
	},
	{
		question: "which test runners?",
		header: "runners",
		multiSelect: true,
		options: [{ label: "vitest" }, { label: "node:test" }],
	},
];

const ASK_TURN = {
	events: [
		{ type: "tool_call_end", callId: "q1", name: "ask_user", input: { questions: QUESTIONS } },
		{ type: "stop", reason: "tool_use" },
	],
};
const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });

function script(dir: string, turns: unknown[]): string {
	const p = join(dir, `faux-${Math.random().toString(36).slice(2)}.json`);
	writeFileSync(p, JSON.stringify(turns), "utf8");
	return p;
}

/** The ONE tool_result of the ask, parsed. */
function answersOf(log: Rec[]): unknown {
	const results = log.filter((r) => r.event.type === "tool_result" && r.event.callId === "q1");
	expect(results, "exactly one durable tool_result for the ask").toHaveLength(1);
	return JSON.parse(String(results[0]!.event.content));
}

describe("T-Q4 — the happy path: two questions, one durable answers JSON", () => {
	it("the human walks the panel and the answers land as ONE tool_result the next turn follows", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-q4-"));
		const faux = script(dir, [ASK_TURN, say("locked in: vite and vitest")]);
		const screen = pty(
			{ ...env, KISO_FAUX_SCRIPT: faux },
			["chat", "q4"],
			"q4",
			[
				["› ", "set the project up\r", 0],
				["which bundler?", "1", 1], // single-select: answers AND advances
				["which test runners?", "1", 2], // multi: toggles vitest
				["◉ vitest", "\r", 3], // ...and enter submits the set
			],
			["locked in: vite and vitest"],
			{ timeout: 25 },
		);
		const log = durable(dirs.home, "q4");

		// ① the panel really rendered — the question, its options, their
		//    descriptions and the walk counter
		expect(screen).toContain("which bundler?");
		expect(screen).toContain("fast dev server");
		expect(screen).toContain("‹ 1/2 ›");
		expect(screen).toContain("which test runners?");

		// ② ONE durable tool_result, carrying both answers in the shapes
		//    the schema promises: a single `choice`, a multi `choices`
		expect(answersOf(log)).toEqual({
			answers: [
				{ q: "which bundler?", choice: "vite" },
				{ q: "which test runners?", choices: ["vitest"] },
			],
		});

		// ③ the call is durable as an ordinary tool call, and the model's
		//    NEXT turn comes after the result — which is the order a real
		//    provider receives the projection in
		const k = kinds(log);
		expect(k).toContain("tool_call_end");
		expect(k.indexOf("tool_result")).toBeLessThan(k.lastIndexOf("stop"));
		expect(screen).toContain("locked in: vite and vitest");

		// ④ the run completed and the ordinary chrome survived the panel
		expect(log.some((r) => r.event.type === "terminal" && (r.event.outcome as { kind: string }).kind === "completed")).toBe(true);
		expect(screen).toMatch(/ctx |tokens|▌|›/);
	}, 90_000);

	it("esc declines: the tool_result NAMES the unanswered questions — silence is never an answer", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-q4d-"));
		const faux = script(dir, [ASK_TURN, say("understood, I will pick")]);
		pty(
			{ ...env, KISO_FAUX_SCRIPT: faux },
			["chat", "q4d"],
			"q4d",
			[
				["› ", "set the project up\r", 0],
				["which bundler?", "\x1b", 1],
			],
			["understood, I will pick"],
			{ timeout: 25 },
		);
		expect(answersOf(durable(dirs.home, "q4d"))).toEqual({
			declined: ["which bundler? (vite, esbuild)", "which test runners? (vitest, node:test)"],
		});
	}, 90_000);
});

describe("T-Q5 — THE MOAT: the ask survives kill -9", () => {
	it("killed mid-panel → resume re-asks in the ask's own words → answered → and a second resume never re-asks", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-q5-"));

		// ── leg 1: the ask opens, and the process dies where it stands ──
		const faux1 = script(dir, [ASK_TURN, say("unreachable")]);
		const first = pty(
			{ ...env, KISO_FAUX_SCRIPT: faux1 },
			["chat", "q5"],
			"q5",
			[["› ", "set the project up\r", 0]],
			[],
			{ timeout: 25, killWhen: "which bundler?" },
		);
		expect(first).toContain("which bundler?"); // the panel was up when it died
		const afterKill = durable(dirs.home, "q5");
		// the durable log holds the CALL and the STARTED execution, and no
		// result — the crash window, exactly as the ① probe described it
		expect(kinds(afterKill)).toContain("tool_call_end");
		expect(kinds(afterKill)).toContain("tool_execution_started");
		expect(afterKill.filter((r) => r.event.type === "tool_result")).toHaveLength(0);
		expect(afterKill.some((r) => r.event.type === "terminal")).toBe(false); // the run is open

		// ── leg 2: resume — the uncertainty surface, in the ask's words ──
		// The ① probe's H2: recovery blocks on a started-unreported
		// execution regardless of idempotency, so the human is asked
		// first. The COPY is the ask's; the mechanism is the runtime's.
		// The faux script continues at its DURABLE position (fauxSkip): the
		// crashed run consumed turn 1, so turn 2 is what the resumed model
		// says — and turn 2 is the RE-ASK. That is the honest arc this
		// round ships: the framework does not re-present the panel by
		// itself (the ① probe: a rerun verdict fills an error result and
		// hands the decision back to the model); the model re-issues the
		// call, and THEN the panel comes back.
		const faux2 = script(dir, [ASK_TURN, ASK_TURN, say("locked in after the crash")]);
		const second = pty(
			{ ...env, KISO_FAUX_SCRIPT: faux2 },
			["resume", "q5"],
			"q5",
			[
				["ask it again?", "1\r", 0], // 1 = re-ask (the rerun resolution)
				["which bundler?", "2", 2], // the panel RE-PRESENTS — esbuild this time
				["which test runners?", "2", 3], // node:test
				["◉ node:test", "\r", 4],
			],
			["locked in after the crash"],
			{ timeout: 30 },
		);

		// the interrupted ask was announced as a QUESTION, not as a side
		// effect that may have applied
		expect(second).toContain("an unanswered question was interrupted — ask it again?");
		expect(second).toContain("1 re-ask · 3 drop");
		expect(second).not.toContain("did the interrupted execution apply?");

		// the SAME questions came back, and were answered
		expect(second).toContain("which bundler?");
		expect(second).toContain("which test runners?");
		const answered = durable(dirs.home, "q5");
		const results = answered.filter((r) => r.event.type === "tool_result");
		const last = JSON.parse(String(results[results.length - 1]!.event.content));
		expect(last).toEqual({
			answers: [
				{ q: "which bundler?", choice: "esbuild" },
				{ q: "which test runners?", choices: ["node:test"] },
			],
		});
		// the human's verdict is durable, and the run reached its terminal
		expect(answered.some((r) => r.event.type === "tool_execution_resolved" && r.event.resolution === "rerun")).toBe(true);
		expect(answered.some((r) => r.event.type === "terminal")).toBe(true);
		expect(second).toContain("locked in after the crash");

		// ── leg 3: a SECOND resume asks nothing — the answer is durable ──
		const startedBefore = answered.filter((r) => r.event.type === "tool_execution_started").length;
		const third = pty({ ...env, KISO_FAUX_SCRIPT: script(dir, [say("nothing to do")]) }, ["resume", "q5"], "q5", [], ["› "], {
			timeout: 20,
		});
		expect(third).not.toContain("which bundler?");
		expect(third).not.toContain("ask it again?");
		expect(third).not.toContain("did the interrupted execution apply?");
		// nothing re-executed: no new ask, no new started execution
		expect(durable(dirs.home, "q5").filter((r) => r.event.type === "tool_execution_started")).toHaveLength(startedBefore);
	}, 180_000);
});

describe("T-Q6 — the races, both orderings", () => {
	it("an answer landing in the same instant as the kill is durable EXACTLY once — or not at all, never half", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-q6a-"));
		const faux = script(dir, [ASK_TURN, say("raced through")]);
		// The answer key is fed the moment the panel appears, and the kill
		// predicate fires on the same needle: the two race for real.
		pty(
			{ ...env, KISO_FAUX_SCRIPT: faux },
			["chat", "q6a"],
			"q6a",
			[["› ", "set the project up\r", 0], ["which bundler?", "1", 0]],
			[],
			{ timeout: 25, killWhen: "which bundler?" },
		);
		const log = durable(dirs.home, "q6a");
		// whoever won, the durable record is coherent: at most ONE result
		// for the call, and if it exists it is a COMPLETE answers JSON —
		// never a partial form, because per-toggle durability does not
		// exist (the round's explicit walk-back)
		const results = log.filter((r) => r.event.type === "tool_result" && r.event.callId === "q1");
		expect(results.length).toBeLessThanOrEqual(1);
		if (results.length === 1) {
			const parsed = JSON.parse(String(results[0]!.event.content)) as { answers?: unknown[]; declined?: unknown[] };
			expect(parsed.answers ?? parsed.declined).toBeDefined();
			if (parsed.answers !== undefined) expect(parsed.answers).toHaveLength(2);
		}
		// and the log is loadable and contiguous either way
		expect(log.map((r) => r.event.seq)).toEqual([...Array(log.length).keys()]);
	}, 90_000);

	it("an ABORT with the panel up cancels it: the decline is recorded, and no pending state is orphaned", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-q6b-"));
		const faux = script(dir, [ASK_TURN, say("after the abort")]);
		const screen = pty(
			{ ...env, KISO_FAUX_SCRIPT: faux },
			["chat", "q6b"],
			"q6b",
			[
				["› ", "set the project up\r", 0],
				["which bundler?", "\x03", 1], // Ctrl+C — abort with the panel up
			],
			["aborting run"],
			{ timeout: 25 },
		);
		const log = durable(dirs.home, "q6b");
		expect(screen).toContain("aborting run");
		// the ask closed with a DECLINE — recorded, not silent
		const results = log.filter((r) => r.event.type === "tool_result" && r.event.callId === "q1");
		expect(results).toHaveLength(1);
		expect(JSON.parse(String(results[0]!.event.content))).toHaveProperty("declined");
		// no orphan: the execution reported, and the run reached a terminal
		expect(kinds(log)).toContain("tool_execution_succeeded");
		expect(log.some((r) => r.event.type === "terminal")).toBe(true);
		expect(log.map((r) => r.event.seq)).toEqual([...Array(log.length).keys()]);
	}, 90_000);

	it("a REDIRECT gesture with the panel up: the panel owns the keys, the decline is recorded, the words never leak", () => {
		const { env, dirs } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-q6c-"));
		const faux = script(dir, [ASK_TURN, say("carried on")]);
		const screen = pty(
			{ ...env, KISO_FAUX_SCRIPT: faux },
			["chat", "q6c"],
			"q6c",
			[
				["› ", "set the project up\r", 0],
				["which bundler?", "/@", 1], // the menu and picker openers — swallowed
				["which bundler?", "\x1b\r", 2], // the redirect gesture (alt+⏎)
			],
			["carried on"],
			{ timeout: 25 },
		);
		const log = durable(dirs.home, "q6c");
		// the panel owned the keys: the menu and the picker never opened
		// under it, and nothing typed reached the composer ...
		expect(screen).not.toContain("/help");
		// ... the gesture closed the ask as a DECLINE, recorded honestly ...
		expect(answersOf(log)).toEqual({
			declined: ["which bundler? (vite, esbuild)", "which test runners? (vitest, node:test)"],
		});
		// ... and nothing became a turn behind the panel's back.
		expect(log.filter((r) => r.event.type === "user_input").map((r) => String(r.event.content))).toEqual(["set the project up"]);
		// no orphan state: the execution reported and the run terminated
		expect(kinds(log)).toContain("tool_execution_succeeded");
		expect(log.some((r) => r.event.type === "terminal")).toBe(true);
	}, 90_000);
});
