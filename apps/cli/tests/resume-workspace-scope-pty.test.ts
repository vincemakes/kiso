/**
 * 0.40.0 — `kiso resume` opens on the sessions that STARTED in this
 * workspace; tab shows all of them.
 *
 * Two real sessions in two real directories, one KISO_HOME. The picker
 * opened in the first lists only the first (the title says 1 of 2); tab
 * lists both and tags the foreign one with where it came from. The
 * recorded workspace is read from each session's profile sidecar —
 * written at revision 1 by the process that started it, which is the
 * only process that knows.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { execFileSync } from "node:child_process";
import { CLI, fauxScript, ptyRun, spares } from "./helpers/pty.js";

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

describe("0.40.0 — the resume picker is scoped to the workspace (PTY)", () => {
	it("one row from here, tab shows both, the foreign row names its workspace", () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "kiso-ws-pty-")));
		const alpha = join(root, "alpha");
		const beta = join(root, "beta");
		mkdirSync(alpha);
		mkdirSync(beta);
		// a faux script is read from a NEW session's durable position — the
		// start — so each process gets its own
		const answer = (text: string): string => fauxScript([{ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]);
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: answer("alpha answered.") });
		const e = env as NodeJS.ProcessEnv;
		ptyRun(["--mode", "bypass", "ws-alpha"], e, { cwd: alpha, feeds: [["/mode to switch", "the alpha task\r"], ["alpha answered.", "exit\r"]] });
		ptyRun(["--mode", "bypass", "ws-beta"], { ...e, KISO_FAUX_SCRIPT: answer("beta answered.") }, { cwd: beta, feeds: [["/mode to switch", "the beta task\r"], ["beta answered.", "exit\r"]] });

		// the record: each session's revision 1 names where it started
		const ws = (id: string): unknown => (JSON.parse(readFileSync(join(dirs.home, "sessions", `${id}.meta.json`), "utf8")) as { profile: { workspace: unknown } }).profile.workspace;
		expect(ws("ws-alpha")).toBe(alpha);
		expect(ws("ws-beta")).toBe(beta);

		const out = strip(
			ptyRun(["--mode", "bypass", "resume"], e, {
				cwd: alpha,
				feeds: [
					["this workspace 1 of 2", "\t"],
					["all 2", "\x1b"],
				],
			}),
		);
		expect(out).toContain("sessions · this workspace 1 of 2 · tab all");
		expect(out).toContain("the alpha task");
		expect(out).toContain("sessions · all 2 · tab this workspace (1)");
		// under ALL the foreign row says where it came from
		expect(out).toMatch(/the beta task[^\n]*beta/);

		// `kiso sessions` (lead's ruling): the PIPE defaults to every session
		// with today's bytes; an explicit --current scopes it; the TTY
		// defaults to this workspace with a header naming both counts
		const piped = (...flags: string[]): string => execFileSync(process.execPath, [CLI, "sessions", ...flags], { cwd: alpha, env: e, encoding: "utf8" });
		const all = piped();
		expect(all).toContain("ws-alpha");
		expect(all).toContain("ws-beta");
		const current = piped("--current");
		expect(current).toContain("ws-alpha");
		expect(current).not.toContain("ws-beta");
		const tty = strip(ptyRun(["sessions"], e, { cwd: alpha, feeds: [] }));
		expect(tty).toContain("1 of 2 sessions from this workspace · --all lists every one");
		expect(tty).toContain("ws-alpha");
		expect(tty).not.toContain("ws-beta");
	}, 300_000);
});
