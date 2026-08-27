/**
 * TV-1B ③ — the thin task driver on a REAL PTY (40×80): the checklist
 * stops lying at settle, and one keypress runs the check.
 *
 * The flagship arc: a faux turn marks every item done → the settled
 * block's tail says "no passing check yet" (never "not checked" — a
 * failed check is also not a passing one) → the offer panel renders →
 * digit 1 seeds ONE ordinary run whose durable input carries
 * source:"system" → the seed renders as machinery (named, never a user
 * chip) → the verify run's shell success settles → the block
 * re-renders "checked ✓" WITHOUT any new task_set (the settle
 * synthesizes the display from the durable assessment).
 *
 * The dismissal arc: Esc consumes the offer for this claims-set — a
 * later settle over the SAME claims never re-offers.
 *
 * KISO_MODE=bypass (the permission flow is not under test); the OFFER
 * panel is driver-initiated and renders regardless of mode.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const TASK_EXT = join(fileURLToPath(new URL("../../..", import.meta.url)), "extensions", "task", "src", "kiso-task.mjs");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.environ["KISO_MODE"] = "bypass"
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", "tv1b"])
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 80, 0, 0))
    full = b""
    idx = 0
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
    sys.stdout.write("===OUT===\\n" + full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], workdir: string, timeout = 60): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-tv1b-drv-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${timeout})
`;
	const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 120_000, env: process.env });
	return /===OUT===\n([\s\S]*)$/.exec(out)![1]!;
}

const DONE_ITEMS = [
	{ text: "implement", status: "done" },
	{ text: "verify with tests", status: "done" },
];

function setup(script: unknown): { env: NodeJS.ProcessEnv; workdir: string } {
	const { env, dirs } = isolatedEnv();
	writeFileSync(join(dirs.extensions, "kiso-task.mjs"), readFileSync(TASK_EXT, "utf8"), "utf8");
	const dir = mkdtempSync(join(tmpdir(), "kiso-tv1b-"));
	const workdir = join(dir, "work");
	mkdirSync(workdir, { recursive: true });
	const scriptPath = join(dir, "faux.json");
	writeFileSync(scriptPath, JSON.stringify(script), "utf8");
	return { env: { ...env, KISO_FAUX_SCRIPT: scriptPath }, workdir };
}

describe("TV-1B ③ — the thin task driver (real PTY, 40×80)", () => {
	it("the flagship arc: no passing check yet → offer → 1 → machinery seed → shell success → checked ✓, synthesized without a new task_set", () => {
		const { env, workdir } = setup([
			{ events: [{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: DONE_ITEMS } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
			// the VERIFICATION run (seeded by the driver, source:"system")
			{ events: [{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "echo ok" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "checks pass." }, { type: "stop", reason: "end_turn" }] },
		]);
		const out = ptyRun(
			env,
			[
				["▌ ", "go\r"],
				["finish the checklist?", "1"], // the offer — digit commits
				["checked ✓", "exit\r"], // the synthesized verdict — then quit
			],
			workdir,
		);

		// the first settle told the truth about the unchecked claims
		expect(out).toContain("no passing check yet");
		// the offer rendered with its plain options
		expect(out).toContain("finish the checklist?");
		expect(out).toContain("run a verification pass");
		// the seed rendered as MACHINERY, and the sentence is visible.
		// R2 (law 1.3): the row NAMES itself machinery rather than wearing
		// a `◆` that said nothing the words did not.
		expect(out).toContain("verification pass");
		expect(out).toContain("Verify the completed work");
		// the verify settle synthesized the verdict — no new task_set exists
		expect(out).toContain("checked ✓");
		// the order is the arc's order
		// byte ORDER between the settled block and the panel is frame-batched
		// (the merged sync frame) — the arc order that is stable: the offer
		// precedes the machinery seed, which precedes the synthesized verdict.
		const offer = out.indexOf("finish the checklist?");
		const seed = out.indexOf("Verify the completed work"); // R2: the seed's sentence, not the offer's label
		const done = out.indexOf("checked ✓");
		expect(seed).toBeGreaterThan(offer);
		expect(done).toBeGreaterThan(seed);
	});

	it("the dismissal arc: Esc consumes the offer — the SAME claims never re-offer on a later settle", () => {
		const { env, workdir } = setup([
			{ events: [{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: DONE_ITEMS } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "all done." }, { type: "stop", reason: "end_turn" }] },
			// the SECOND user turn — same claims still all-done in the log
			{ events: [{ type: "text_delta", text: "nothing new." }, { type: "stop", reason: "end_turn" }] },
		]);
		const out = ptyRun(
			env,
			[
				["▌ ", "go\r"],
				["finish the checklist?", "\u001b"], // Esc — dismissed, consumed
				["all done.", "again\r"], // a later ordinary turn
				["nothing new.", "exit\r"],
			],
			workdir,
		);

		// the offer appeared EXACTLY once — the dismissal consumed it
		expect(out.indexOf("finish the checklist?")).toBe(out.lastIndexOf("finish the checklist?"));
		// no verification was seeded. R2: the seed's `◆` is retired (law
		// 1.3 — the mark said nothing the words did not), so the needle
		// cannot be the mark any more. It is the seed's own SENTENCE,
		// which the offer's option label does not contain — `verification
		// pass` alone would match the label `run a verification pass` and
		// this negative would be unfalsifiable.
		expect(out).not.toContain("Verify the completed work");
		// the verdict line still told the truth at both settles
		expect(out).toContain("no passing check yet");
	});

	it("the stale arc + the verifier that cannot re-arm itself: verified → durable mutation → check outdated offers; the verify run's OWN task_set is consumed with the offer", () => {
		const { env, workdir } = setup([
			// turn 1: claims done AND a passing shell check — verified at settle
			{
				events: [
					{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items: DONE_ITEMS } },
					{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "echo ok" } },
					{ type: "stop", reason: "tool_use" },
				],
			},
			{ events: [{ type: "text_delta", text: "done and checked." }, { type: "stop", reason: "end_turn" }] },
			// turn 2 (user): a DURABLE mutation-class execution — the trajectory
			// staleness TV-1A can actually see (never a bare filesystem edit)
			{ events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "new.txt", content: "x", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "changed something." }, { type: "stop", reason: "end_turn" }] },
			// turn 3 (the VERIFY run): emits its OWN task_set + the check —
			// that task_set belongs to the SAME accepted offer, never a re-arm
			{
				events: [
					{ type: "tool_call_end", callId: "t2", name: "task_set", input: { items: DONE_ITEMS } },
					{ type: "tool_call_end", callId: "s2", name: "shell", input: { command: "echo ok" } },
					{ type: "stop", reason: "tool_use" },
				],
			},
			{ events: [{ type: "text_delta", text: "still green." }, { type: "stop", reason: "end_turn" }] },
		]);
		const out = ptyRun(
			env,
			[
				["▌ ", "go\r"],
				["done and checked.", "next\r"], // verified settle — NO offer expected
				// the settled block's bytes are frame-batched BEHIND the panel —
				// answer the panel on its own needle; the verdict flushes after
				["finish the checklist?", "1"], // the stale settle offers — accept
				["still green.", "exit\r"], // the verify settle — consumed, no re-offer
			],
			workdir,
		);

		// the first settle was VERIFIED — checked, and no offer before the mutation
		expect(out).toContain("checked ✓");
		// the stale settle told the narrowed truth
		expect(out).toContain("check outdated");
		expect(out).toContain("work may have changed after it");
		// exactly ONE offer in the whole arc: the verified settle never
		// offered, and the verifier's own task_set was consumed with it
		expect(out.indexOf("finish the checklist?")).toBe(out.lastIndexOf("finish the checklist?"));
		// the machinery seed rendered for the accepted offer
		expect(out).toContain("verification pass");
	});
});
