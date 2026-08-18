/**
 * TUI2-R2 slices ②/③ — bare `kiso resume` opens the picker; the
 * listing wears the same badges; every non-TTY path is untouched.
 *
 * The A-1 circle, pinned here: bare `kiso` (no args) keeps today's
 * new-session semantics — the picker lives behind bare `kiso resume`
 * and nowhere else. Changing the default command's meaning is the one
 * navigation change with real blast radius, and it is not this round's.
 *
 * The non-TTY half matters as much as the TTY half. `kiso sessions` is
 * something scripts read: its piped bytes are a machine interface and
 * this round must not move one of them. A picker is a TTY surface by
 * definition — there is nobody to pick when stdin is a pipe — so the
 * piped `kiso resume` keeps the usage error and the exit code it has
 * always had.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import type { Event } from "@vincemakes/kiso-core";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { CLI, ptyRun, settledScreen } from "./helpers/pty.js";

/** Three sessions in three states, written by the REAL writer into the
 *  isolated home the CLI will read. */
async function fixtureHome(home: string): Promise<void> {
	const store = new SessionStore(join(home, "sessions"));
	const write = async (id: string, runs: { runId: string; events: Omit<Event, "seq">[] }[]): Promise<void> => {
		let seq = 0;
		for (const run of runs) {
			for (const ev of run.events) {
				await store.append(id, run.runId, { ...ev, seq } as Event);
				seq += 1;
			}
		}
	};
	const user = (content: string): Omit<Event, "seq"> => ({ type: "user_input", content }) as Omit<Event, "seq">;
	const stop = (): Omit<Event, "seq"> => ({ type: "stop", reason: "end_turn" }) as Omit<Event, "seq">;
	const term = (): Omit<Event, "seq"> => ({ type: "terminal", outcome: { kind: "completed" } }) as unknown as Omit<Event, "seq">;
	await write("wrapper-probe", [{ runId: "r1", events: [user("probe the wrapper"), stop(), term()] }]);
	await write("bench-refactor", [
		{ runId: "r1", events: [user("refactor the bench"), { type: "tool_execution_started", executionId: "x1", callId: "c1", name: "shell", input: { command: "npm test" } } as Omit<Event, "seq">] },
	]);
	await write("tui2-dogfood", [{ runId: "r1", events: [user("dogfood the tui"), stop()] }]);
	store.closeAll();
}

describe("TUI2-R2 ② — bare `kiso resume`: the picker is a TTY surface", () => {
	it("NON-TTY: the piped bare resume keeps today's usage error and exit 2, byte for byte", async () => {
		const { env, dirs } = isolatedEnv();
		await fixtureHome(dirs.home);
		let code = 0;
		let stderr = "";
		try {
			execFileSync("node", [CLI, "resume"], { env: env as NodeJS.ProcessEnv, input: "", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			const e = err as { status: number; stderr: string };
			code = e.status;
			stderr = e.stderr;
		}
		expect(code).toBe(2);
		expect(stderr).toContain('usage: kiso resume <sessionId> ["prompt"]');
		// and NOT the picker: no band, no badge, nothing interactive
		expect(stderr).not.toContain("sessions\n");
		expect(stderr).not.toContain("▌");
	}, 120_000);

	it("TTY: bare `kiso resume` opens the picker, typing filters it, and ⏎ resumes the picked session", async () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "default" });
		await fixtureHome(dirs.home);
		const raw = ptyRun(["resume"], env as NodeJS.ProcessEnv, {
			// the picker is up as soon as the band names itself; type a
			// filter that can only mean one session, then take it
			feeds: [["sessions", "ben"]],
			// the pick lands in the recovery flow's uncertainty gate (that IS
			// the proof it went into the existing resume path), so the gate
			// gets an answer — otherwise the flow waits for a human and the
			// driver burns its whole timeout, which starves vitest's
			// reporter RPC at suite scale (the R1.5 spawn-cost lesson).
			delays: [[4, "\r"], [7, "3\r"]],
			timeout: 25,
		});
		// the picker's own frame: the band, all three sessions, the counter
		expect(raw).toContain("bench-refactor");
		expect(raw).toContain("wrapper-probe");
		expect(raw).toContain("(1/3)");
		// the filter narrowed it to one
		expect(raw).toContain("(1/1)");
		// ⏎ went into the EXISTING resume path, and the proof is what the
		// resume path does FIRST: bench-refactor holds an undecided
		// execution, so the recovery flow's uncertainty gate opens on it.
		// Nothing about the picker resumes a session — it hands an id to
		// the flow that always did.
		const screen = settledScreen(raw).join("\n");
		expect(screen + raw).toContain("interrupted execution");
		// and the picker is GONE once it has been taken
		expect(settledScreen(raw).join("\n")).not.toContain("(1/1)");
		expect(raw).not.toContain("usage: kiso resume");
	}, 240_000);

	it("the A-1 circle: bare `kiso` (no args) still starts a NEW session — the picker is behind `resume` only", async () => {
		const { env, dirs } = isolatedEnv({ KISO_MODE: "default" });
		await fixtureHome(dirs.home);
		const raw = ptyRun([], env as NodeJS.ProcessEnv, { delays: [[3, "exit\r"]] });
		// a fresh session id (the ISO stamp), never the picker's band
		expect(raw).toMatch(/session \d{4}-\d{2}-\d{2}T\d{2}-\d{2}/);
		expect(raw).not.toContain("(1/3)");
	}, 240_000);
});

describe("TUI2-R2 ③ — `kiso sessions`: the badges on a TTY, the same bytes in a pipe", () => {
	it("PIPE: the listing's bytes are today's renderSessionLine, unchanged — no badge, no footer, no colour", async () => {
		const { env, dirs } = isolatedEnv();
		await fixtureHome(dirs.home);
		const out = execFileSync("node", [CLI, "sessions"], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
		// the keyless demo's own notice is makeAgent's and predates this
		// round; the LISTING is everything after it
		const lines = out.trimEnd().split("\n").filter((l) => l !== "" && !l.startsWith("[faux mode"));
		expect(lines).toHaveLength(3); // three sessions, three lines, nothing else
		for (const line of lines) {
			expect(line).toMatch(/^\S+\s+\d+ runs\s+\d+ events\s+\S+\s/); // the historical shape
			expect(line).not.toMatch(/[✓✗▌?◌]/); // no badge in a pipe
			expect(line).not.toContain("\x1b"); // zero ANSI
		}
		expect(out).not.toContain("kiso resume picks interactively");
	}, 120_000);

	it("TTY: the same projection, printed — a badge per row and the footer that names the next move", async () => {
		const { env, dirs } = isolatedEnv();
		await fixtureHome(dirs.home);
		const raw = ptyRun(["sessions"], env as NodeJS.ProcessEnv, { timeout: 30 });
		expect(raw).toContain("bench-refactor");
		expect(raw).toContain("uncertain — needs your verdict");
		expect(raw).toContain("interrupted mid-run");
		expect(raw).toContain("completed clean");
		expect(raw).toContain("3 sessions · kiso resume picks interactively");
	}, 240_000);
});
