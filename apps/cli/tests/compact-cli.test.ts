/**
 * ADR-0044 — the /compact command through the CLI's real entry:
 *
 *  1. PTY (24×80): a seeded long session is resumed; /status shows the
 *     context BEFORE; a /compact typed MID-RUN is refused (the summary
 *     call is off-loop and must never race a run); after the turn, a
 *     /compact lands the `summarized` event on disk with the NoticeCell,
 *     and a second /status shows the context DROPPED (the compression
 *     took effect in the live session).
 *  2. Pipe: /compact as the first line of a seeded long session works
 *     end to end with ZERO ANSI (the non-TTY byte discipline), and the
 *     summary event is durable.
 *  3. W18: the indeterminate row (▘ compacting · rounds · tokens ·
 *     elapsed · esc to cancel) is LIVE for the whole call — a REAL 1.5s
 *     adapter delay via the faux delay pseudo-event — and esc cancels
 *     it mid-flight with nothing persisted.
 *
 * The summary call consumes a faux script turn (the same adapter serves
 * it) — the scripts below account for it explicitly.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — THE RECAP IS THE TURN'S
 * COST, NOT ITS WORK.
 *
 * The turn's work is said ONCE now, by the compositor's fold line, in
 * the place the work happened and carrying the key that reopens it.
 * This row used to repeat the same terms a few rows below under a
 * different clock — the fold printed the kernel's MEASURED thinking
 * seconds, the recap the whole turn's wall, both labelled "thought" —
 * which is the doubling the owner called out ("two lines saying the
 * same thing, the UI gets strange"). The row reads `✦ took 23s · in
 * 12k out 900 · cache 88% · ctx left 41%`, and `took` is the honest
 * name for the number it always carried.
 *
 * A turn whose work did NOT fold (it spilled past the live region, or
 * it hit trouble) keeps every one of its rows on screen — the work is
 * not lost by its absence from this row, it is standing right there.
 *
 * Needles that waited on a recap TERM ("0 tools", "1 shell") wait on
 * `took ` now: it is what the recap always writes, it marks the same
 * moment (the turn has settled), and it sits after the ✦'s SGR reset
 * so it survives contiguously in the raw stream a PTY driver scans.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The ORDERED PTY driver: feeds[i] is written only after feeds[i-1]'s
 *  needle matched, and each feed is consumed exactly once. */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout, session, mode_flag):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        argv = ["node", cli]
        if mode_flag:
            argv += ["--mode", mode_flag]
        argv += ["chat", session]
        os.execvp("node", argv)
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
                # THE CHILD IS GONE — on Linux. A pty master raises EIO
                # once the last slave fd closes; macOS returns b"" for the
                # same event, and that path (below) sets done. Treating
                # only the macOS shape as an exit made every Linux run
                # report "the CLI never exited" on a CLI that had exited
                # cleanly a fraction of a second earlier.
                #
                # R3c keeps its teeth: reap with WNOHANG for up to a
                # second, and only call it an exit if the child really is
                # gone. A process still alive behind a broken pty is a
                # stall, and still spends its wall.
                reaped = False
                for _ in range(100):
                    try:
                        if os.waitpid(pid, os.WNOHANG)[0] != 0:
                            reaped = True
                            break
                    except ChildProcessError:
                        reaped = True
                        break
                    time.sleep(0.01)
                if reaped:
                    done = True
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
    # R3c: report HOW this ended — eof, or the wall with the index of the
    # first needle nobody reached. A scenario that waits out its budget
    # passes its assertions on a SIGTERM'd transcript; this is what makes
    # that audible. stderr, so the transcript stays byte-exact.
    sys.stderr.write("KISO_PTY_END %s %.2f %s" % ("eof" if done else "wall", time.time() - (end - timeout), idx) + chr(10))
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(
	env: NodeJS.ProcessEnv,
	feeds: [string, string][],
	workdir: string,
	session: string,
	options: { modeFlag?: string; timeout?: number } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-compact-pty-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const py = (v: string | null | undefined): string => (v === null || v === undefined ? "None" : JSON.stringify(v));
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${options.timeout ?? 60}, ${JSON.stringify(session)}, ${py(options.modeFlag)})
`;
	const res = spawnSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
	if (res.status !== 0) throw new Error(`pty driver failed (${res.status}): ${res.stderr}`);
	const m = /KISO_PTY_END (eof|wall) ([0-9.]+) (\d+)/.exec(res.stderr ?? "");
	if (m !== null && m[1] === "wall") {
		const at = Number(m[3]);
		throw new Error(
			`the PTY scenario spent its whole wall (${m[2]}s) — the CLI never exited, stuck at feed ${at}: ${JSON.stringify(feeds[at]?.[0] ?? "(all fed)")} (R3c).`,
		);
	}
	return res.stdout;
}

/** Seed a LONG session (7 chunky rounds + an open final input — the crash
 *  shape, so chat's recovery resumes it). 300-line results keep the ctx
 *  estimate comfortably under the microcompact threshold (window 20k →
 *  threshold 10k): the ONLY compaction in this test is /compact. */
function seedSession(home: string, id: string): void {
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	let seq = 0;
	const lines: string[] = [];
	const push = (event: Record<string, unknown>): void => {
		lines.push(JSON.stringify({ runId: "r1", ts: seq, event }));
		seq += 1;
	};
	push({ seq, type: "user_input", content: "start" });
	for (let i = 0; i < 7; i++) {
		push({ seq, type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		push({ seq, type: "tool_result", callId: `r${i}`, content: "line\n".repeat(300), isError: false });
		push({ seq, type: "user_input", content: `t${i}` });
	}
	writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
}

describe("ADR-0044 cli: /compact on a real PTY", () => {
	it("refuses mid-run, then lands the summarized event, the NoticeCell, and a DROPPED ctx", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact-pty2-"));
		const { env: isoEnv, dirs } = isolatedEnv({ KISO_CONTEXT_WINDOW: "20000" });
		const home = dirs.home;
		seedSession(home, "kc");
		// fauxSkip = 7 (the seed's results), so the sliced script starts at
		// turn 7: recovery end_turn + live turn (a sleep-4 shell — bypass
		// auto-approves, no human question, so the mid-run window is the
		// shell itself; 4s gives the driver's "sleep 4" cell needle a wide,
		// deterministic mid-run margin) + the turn's second model call +
		// the summary turn.
		const script = [
			...Array.from({ length: 7 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] })),
			{ events: [{ type: "stop", reason: "end_turn" }] }, // recovery resume
			{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "sleep 4" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "text_delta", text: "## Goal\nserve the file reads\n## Constraints\nnothing may be dropped\n## User requests\nseven rounds of reads\n## Files and changes\nf0-f6.ts read\n## Errors and fixes\nnone\n## Current work\nseven rounds summarized\n## Next steps\nkeep going" }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");
		const env = { ...isoEnv, KISO_FAUX_SCRIPT: scriptPath };

		const out = ptyRun(
			env,
			[
				// The recovery resume completes, the REPL arms its first prompt.
				["/ commands · \u2191 history", "/status\r"],
				["ctx ~", "go\r"],
				// The go turn's OWN shell cell ("sleep 4") marks the run
				// mid-flight — the recovery's leftover "working" status must
				// never trigger this feed (that race submitted the /compact
				// before the turn had started). A /compact NOW must be
				// REFUSED, never raced against the running turn. (The
				// refusal notice sits in the buffer; the next needle waits
				// for the run to end.)
				["sleep 4", "/compact\r"],
				// The go turn's END — a /compact NOW runs for real (the
				// summary call consumes its own script turn). The "you> "
				// prompt alone is ambiguous (the /status's own prompt
				// precedes the go turn).
				//
				// R3g: this needle used to be a RECAP term ("1 tool", then
				// "1 shell"). The recap says the turn's cost now, not its
				// work, so no term of it is unique to this turn — and the
				// driver fires ANY unfired feed whose needle is in the
				// buffer, so a shared term ("took ") fires on the recovery
				// resume's recap, before the go turn has even started.
				//
				// The shell's own settled row is what marks this turn and
				// only this turn. It lands ~4s in (the sleep), and the
				// driver polls at 0.2s, so the second model call — a faux
				// return, microseconds — has always completed by the time
				// the keystrokes are written.
				//
				// (This turn holds exactly ONE cell, and a one-cell turn
				// does not fold — one row into one row is pure loss — so
				// its work has no summary line anywhere. The row itself is
				// the record, which is why the needle can be the row.)
				["exit 0", "/compact\r"],
				["/ commands · \u2191 history", "/status\r"],
				["ctx ~", "exit\r"],
			],
			dir,
			"kc",
			{ modeFlag: "bypass" },
		);
		const plain = stripANSI(out);

		// The mid-run refusal is visible.
		expect(plain).toContain("[/compact] a turn is running");
		// W18 re-baseline: the success NoticeCell is the RECAP — the covered
		// rounds (9 total − 4 kept = 5, pinned with the coversToSeq:14
		// boundary below), the one summary, the savings, and the elapsed.
		expect(plain).toContain("[/compact] ✦ compacted · 5 rounds → 1 summary · saved ~");
		// The context DROPPED after the compression: /status printed
		// "ctx ~N%" twice — before (seeded, ~16%) and after (~7%).
		const ctxs = [...out.matchAll(/ctx ~(\d+)%/g)].map((m) => Number(m[1]));
		expect(ctxs.length).toBeGreaterThanOrEqual(2);
		expect(ctxs.at(-1)!).toBeLessThan(ctxs[0]!);

		// The summarized event is on disk, keyed to the covered boundary:
		// 9 rounds total (8 seed inputs at 0..21 + the go turn at 22) →
		// K=4 kept → covered rounds 1-5, boundary = the event before the
		// first kept round's input (seq 15) = 14.
		const durable = readFileSync(join(home, "sessions", "kc.jsonl"), "utf8");
		expect(durable).toContain('"type":"summarized"');
		expect(durable).toContain('"coversToSeq":14');
		expect(durable).toContain("## Goal\\nserve the file reads\\n## Constraints\\nnothing may be dropped\\n## User requests\\nseven rounds of reads\\n## Files and changes\\nf0-f6.ts read\\n## Errors and fixes\\nnone\\n## Current work\\nseven rounds summarized\\n## Next steps\\nkeep going");
	});

	it("W18: the indeterminate row is LIVE for the whole call (a REAL 1.5s adapter delay), esc cancels it mid-flight, and nothing is persisted", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact-w18-pty-"));
		const { env: isoEnv, dirs } = isolatedEnv({ KISO_CONTEXT_WINDOW: "20000" });
		const home = dirs.home;
		seedSession(home, "kc");
		// The summary call must take REAL seconds — the indicator's whole
		// reason: every summarize local step is a linear scan (instant at
		// this size), so the ONLY honest slow part is the adapter call
		// itself. The faux script's delay pseudo-event (packages/evals,
		// gated by its own test) provides it at the process level.
		const script = [
			...Array.from({ length: 7 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] })),
			{ events: [{ type: "stop", reason: "end_turn" }] }, // recovery resume
			{ events: [{ type: "delay", ms: 1500 }, { type: "text_delta", text: "Must never land." }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");
		const env = { ...isoEnv, KISO_FAUX_SCRIPT: scriptPath };

		const out = ptyRun(
			env,
			[
				// The recovery resume completes, the REPL arms its first prompt.
				["/ commands · \u2191 history", "/compact\r"],
				// The FIRST paint of the indeterminate row marks the call
				// live — esc lands mid-flight (the call outlives the feed by
				// ~1.4s, so the cancel is never a race against the settle).
				["▘ compacting", "\x1b"],
				// The honest cancel notice — nothing was persisted (ADR-0044).
				["cancelled — nothing was persisted", "/status\r"],
				["ctx ~", "exit\r"],
			],
			dir,
			"kc",
			{ modeFlag: "bypass" },
		);
		const plain = stripANSI(out);

		// The row: the knowable pre-call data (4 covered rounds of the 8
		// seeded, the token estimate) with the cancel affordance right-aligned.
		expect(plain).toContain("▘ compacting · 4 rounds · ~");
		expect(plain).toContain("esc to cancel");
		// The row went LIVE across a real elapsed second — the 1.5s call
		// makes the 1s repaint deterministic (the interval is cleared only
		// when summarize() settles, so it fires even under the abort).
		expect(plain).toContain("tokens · 1s");
		expect(plain).toContain("[/compact] cancelled — nothing was persisted");
		// The cancel left the session untouched: no summarized event on disk.
		const durable = readFileSync(join(home, "sessions", "kc.jsonl"), "utf8");
		expect(durable).not.toContain('"type":"summarized"');
		expect(durable).not.toContain("Must never land.");
	});
});

describe("ADR-0044 cli: /compact through a pipe", () => {
	it("works as the first line of a seeded long session — durable event, zero ANSI", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-compact-pipe-"));
		const { env: isoEnv, dirs } = isolatedEnv({ KISO_CONTEXT_WINDOW: "20000" });
		const home = dirs.home;
		seedSession(home, "kp");
		// A CLOSED seed would need no recovery — but this seed is OPEN
		// (the crash shape): chat's recovery resume consumes script turn 7,
		// then the queued /compact's summary call consumes turn 8.
		const script = [
			...Array.from({ length: 7 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] })),
			{ events: [{ type: "stop", reason: "end_turn" }] }, // recovery resume
			{ events: [{ type: "text_delta", text: "## Goal\nserve the file reads\n## Constraints\nnothing may be dropped\n## User requests\nseven rounds of reads\n## Files and changes\nf0-f6.ts read\n## Errors and fixes\nnone\n## Current work\nseven rounds summarized\n## Next steps\nkeep going" }, { type: "stop", reason: "end_turn" }] },
		];
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");

		const run = runCli(["chat", "kp"], { ...isoEnv, KISO_FAUX_SCRIPT: scriptPath }, { input: "/compact\nexit\n", timeout: 60_000 });
		expect(run.status).toBe(0);
		// W18 re-baseline: the recap (8 seed rounds − 4 kept = 4 covered).
		expect(run.stdout).toContain("[/compact] ✦ compacted · 4 rounds → 1 summary · saved ~");
		expect(run.stdout).not.toContain("\u001b["); // the pipe is byte-clean
		const durable = readFileSync(join(home, "sessions", "kp.jsonl"), "utf8");
		expect(durable).toContain('"type":"summarized"');
		expect(durable).toContain("## Goal\\nserve the file reads\\n## Constraints\\nnothing may be dropped\\n## User requests\\nseven rounds of reads\\n## Files and changes\\nf0-f6.ts read\\n## Errors and fixes\\nnone\\n## Current work\\nseven rounds summarized\\n## Next steps\\nkeep going");
		// The session still loads without corruption.
		expect(new SessionStore(join(home, "sessions")).load("kp").length).toBeGreaterThan(20);
	});
});
