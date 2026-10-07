/**
 * 0.40.0 (the owner's dogfood: a session of one project resumed from another) —
 * one session folder per project, through the real CLI.
 *
 * Real processes in real directories under one KISO_HOME, with the layout
 * ON (the isolated env's pinned folder removed): a session lands in its
 * project's folder; another project's recorded session is refused at every
 * door with where to go; an unknown or inferred one is never refused — it
 * moves here and the line says the tools work here; the first start moves
 * the legacy folder and says so once, with the undo; the undo puts it
 * back. And in a terminal: the picker opens on this project, and
 * `/resume <another project's id>` is refused in the chat.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import { encodeWorkspace } from "../src/projects.js";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const answer = (text: string): string => fauxScript([{ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]);
const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
/** RE-DERIVED (the last sweep, owner 2026-10-06): on a dock a route line is
 *  a notice, folded by words at the content edge — a long path moves to a
 *  row of its own. The words are compared, not where the rows break. */
const words = (t: string): string => strip(t).replace(/\s+/g, " ");

function world() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kiso-pp-")));
	const alpha = join(root, "alpha");
	const beta = join(root, "beta");
	mkdirSync(alpha);
	mkdirSync(beta);
	const { env, dirs } = isolatedEnv({});
	const e = { ...env } as NodeJS.ProcessEnv;
	delete e.KISO_SESSIONS_DIR; // the layout under test
	const folder = (ws: string): string => join(dirs.home, "projects", encodeWorkspace(ws));
	/** a real session, made by a real process in `cwd` */
	const make = (id: string, cwd: string, extra: NodeJS.ProcessEnv = {}): void => {
		const r = runCli(["-p", `the ${id} task`, id], { ...e, KISO_FAUX_SCRIPT: answer(`${id} answered.`), ...extra }, { cwd });
		expect(r.status, `making ${id}: ${r.stderr}`).toBe(0);
	};
	return { root, alpha, beta, home: dirs.home, env: e, folder, make };
}

/** Strip a session's recorded workspace — a legacy session's sidecar. */
function forgetWorkspace(dir: string, id: string): void {
	const path = join(dir, `${id}.meta.json`);
	const meta = JSON.parse(readFileSync(path, "utf8")) as { profile: Record<string, unknown> };
	delete meta.profile.workspace;
	writeFileSync(path, JSON.stringify(meta));
}

function moveSession(from: string, to: string, id: string): void {
	mkdirSync(to, { recursive: true });
	for (const f of [`${id}.jsonl`, `${id}.meta.json`, `${id}.lock`]) if (existsSync(join(from, f))) renameSync(join(from, f), join(to, f));
}

describe("0.40.0 — one session folder per project (CLI)", () => {
	it("a session lands in its project's folder, which records its workspace", () => {
		const w = world();
		w.make("pp-alpha", w.alpha);
		expect(existsSync(join(w.folder(w.alpha), "pp-alpha.jsonl"))).toBe(true);
		expect(JSON.parse(readFileSync(join(w.folder(w.alpha), "workspace.json"), "utf8"))).toMatchObject({ workspace: w.alpha });
		expect(existsSync(join(w.home, "sessions", "pp-alpha.jsonl"))).toBe(false);
	}, 60_000);

	it("another project's recorded session is refused at every door, with where to go", () => {
		const w = world();
		w.make("pp-beta", w.beta);
		const refusal = `this session belongs to ${w.beta} — cd there to resume it`;
		for (const args of [
			["resume", "pp-beta", "continue"],
			["-p", "continue", "pp-beta"],
			["chat", "pp-beta"],
		]) {
			const r = runCli(args, w.env, { cwd: w.alpha, input: "" });
			expect(r.status, args.join(" ")).toBe(2);
			expect(r.stderr, args.join(" ")).toContain(refusal);
		}
		// nothing moved, nothing created
		expect(existsSync(join(w.folder(w.beta), "pp-beta.jsonl"))).toBe(true);
		expect(existsSync(join(w.folder(w.alpha), "pp-beta.jsonl"))).toBe(false);
	}, 60_000);

	it("an unknown session, and an inferred one, are never refused and never moved: each resumes where it is, and this project's picker does not list it", () => {
		const w = world();
		const stash = join(w.home, "stash");
		w.make("pp-lost", w.beta, { KISO_SESSIONS_DIR: stash });
		w.make("pp-guessed", w.beta, { KISO_SESSIONS_DIR: stash });
		forgetWorkspace(stash, "pp-lost");
		forgetWorkspace(stash, "pp-guessed");
		const unknown = join(w.home, "projects", "_unknown");
		moveSession(stash, unknown, "pp-lost");
		// placed by inference: in gamma's folder, with no recorded workspace
		const gamma = join(w.root, "gamma");
		mkdirSync(gamma);
		const gammaDir = w.folder(gamma);
		mkdirSync(gammaDir, { recursive: true });
		writeFileSync(join(gammaDir, "workspace.json"), JSON.stringify({ workspace: gamma }));
		moveSession(stash, gammaDir, "pp-guessed");

		// the lead's gate: resumed from alpha TWICE, still in _unknown
		const turnsIn = (dir: string, id: string): number => (readFileSync(join(dir, `${id}.jsonl`), "utf8").match(/"type":"user_input"/g) ?? []).length;
		for (const n of [2, 3]) {
			const lost = runCli(["-p", `go on ${n}`, "pp-lost"], { ...w.env, KISO_FAUX_SCRIPT: answer("continued.") }, { cwd: w.alpha });
			expect(lost.status, lost.stderr).toBe(0);
			expect(lost.stderr).toContain(`workspace unknown — tools work in ${w.alpha}`);
			expect(turnsIn(unknown, "pp-lost")).toBe(n);
		}
		expect(existsSync(join(w.folder(w.alpha), "pp-lost.jsonl"))).toBe(false);

		const guessed = runCli(["-p", "go on", "pp-guessed"], { ...w.env, KISO_FAUX_SCRIPT: answer("continued.") }, { cwd: w.alpha });
		expect(guessed.status, guessed.stderr).toBe(0);
		expect(guessed.stderr).toContain(`workspace inferred as ${gamma}, never recorded — tools work in ${w.alpha}`);
		expect(turnsIn(gammaDir, "pp-guessed")).toBe(2);
		expect(existsSync(join(w.folder(w.alpha), "pp-guessed.jsonl"))).toBe(false);

		// and alpha's picker still opens on alpha, where neither is listed
		const picker = strip(ptyRun(["--mode", "bypass", "resume"], w.env, { cwd: w.alpha, feeds: [["this workspace · 0 of 2", "\x1b"]] }));
		expect(picker).toContain("resume · this workspace · 0 of 2");
		expect(picker).not.toContain("the pp-lost task");
	}, 90_000);

	it("in the chat, /resume of an unknown session opens it where it is, and /resume back returns to this project's folder", () => {
		const w = world();
		const stash = join(w.home, "stash");
		w.make("pp-lost", w.beta, { KISO_SESSIONS_DIR: stash });
		forgetWorkspace(stash, "pp-lost");
		const unknown = join(w.home, "projects", "_unknown");
		moveSession(stash, unknown, "pp-lost");
		const out = strip(
			ptyRun(["--mode", "bypass", "pp-here"], { ...w.env, KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: "here answered." }, { type: "stop", reason: "end_turn" }] }, ...spares(6)]) }, {
				cwd: w.alpha,
				feeds: [
					["/mode to switch", "the here task\r"],
					["here answered.", "/resume pp-lost\r"],
					// RE-DERIVED (the last sweep, owner 2026-10-06): a switch is a
					// SESSION row on a dock — the id, and the way back
					["/resume pp-here returns", "/resume pp-here\r"],
					["/resume pp-lost returns", "exit\r"],
				],
			}),
		);
		expect(words(out)).toContain(`workspace unknown — tools work in ${w.alpha}`);
		expect(out).toMatch(/SESSION {5}pp-lost · \/resume pp-here returns/);
		expect(out).toMatch(/SESSION {5}pp-here · \/resume pp-lost returns/);
		// nothing moved either way
		expect(existsSync(join(unknown, "pp-lost.jsonl"))).toBe(true);
		expect(existsSync(join(w.folder(w.alpha), "pp-lost.jsonl"))).toBe(false);
		expect(existsSync(join(w.folder(w.alpha), "pp-here.jsonl"))).toBe(true);
		expect(existsSync(join(unknown, "pp-here.jsonl"))).toBe(false);
	}, 90_000);

	it("`kiso sessions` in a pipe lists every project's; --current lists this one's", () => {
		const w = world();
		w.make("pp-alpha", w.alpha);
		w.make("pp-beta", w.beta);
		const all = runCli(["sessions"], w.env, { cwd: w.alpha });
		expect(all.status, all.stderr).toBe(0);
		expect(all.stdout).toContain("pp-alpha");
		expect(all.stdout).toContain("pp-beta");
		const current = runCli(["sessions", "--current"], w.env, { cwd: w.alpha });
		expect(current.stdout).toContain("pp-alpha");
		expect(current.stdout).not.toContain("pp-beta");
	}, 60_000);

	it("the first start moves the legacy folder, says so once with the undo, and the undo puts it back", () => {
		const w = world();
		const legacy = join(w.home, "sessions");
		w.make("pp-a", w.alpha, { KISO_SESSIONS_DIR: legacy });
		w.make("pp-b", w.beta, { KISO_SESSIONS_DIR: legacy });

		const first = runCli(["sessions"], w.env, { cwd: w.alpha });
		expect(first.status, first.stderr).toBe(0);
		expect(first.stderr).toContain("sessions now live in one folder per project — moved 2 (recorded 2 · inferred 0 · unknown 0)");
		expect(existsSync(join(w.folder(w.alpha), "pp-a.jsonl"))).toBe(true);
		expect(existsSync(join(w.folder(w.beta), "pp-b.jsonl"))).toBe(true);
		expect(existsSync(join(legacy, "pp-a.jsonl"))).toBe(false);
		const manifest = /undo: kiso sessions --reverse-migration (\S+)/.exec(first.stderr)?.[1];
		expect(manifest).toBeDefined();
		expect(existsSync(manifest!)).toBe(true);

		// once: the next start has nothing to move and says nothing
		const second = runCli(["sessions"], w.env, { cwd: w.alpha });
		expect(second.stderr).not.toContain("sessions now live");

		const undo = runCli(["sessions", "--reverse-migration", manifest!], w.env, { cwd: w.alpha });
		expect(undo.status, undo.stderr).toBe(0);
		expect(undo.stdout).toContain("moved 2 sessions back");
		expect(existsSync(join(legacy, "pp-a.jsonl"))).toBe(true);
		expect(existsSync(join(legacy, "pp-b.jsonl"))).toBe(true);
		// and the layout stays off: a new session lands in the legacy folder
		w.make("pp-c", w.alpha);
		expect(existsSync(join(legacy, "pp-c.jsonl"))).toBe(true);
		expect(readdirSync(w.folder(w.alpha)).filter((f) => f.endsWith(".jsonl"))).toEqual([]);
	}, 90_000);

	it("in a terminal: the picker opens on this project, and /resume of another project's session is refused in the chat", () => {
		const w = world();
		w.make("pp-alpha", w.alpha);
		w.make("pp-beta", w.beta);
		const picker = strip(ptyRun(["--mode", "bypass", "resume"], w.env, { cwd: w.alpha, feeds: [["this workspace · 1 of 2", "\x1b"]] }));
		expect(picker).toContain("resume · this workspace · 1 of 2");
		expect(picker).toContain("the pp-alpha task");

		const chat = strip(
			ptyRun(["--mode", "bypass", "pp-new"], { ...w.env, KISO_FAUX_SCRIPT: answer("unused.") }, {
				cwd: w.alpha,
				feeds: [
					["/mode to switch", "/resume pp-beta\r"],
					["cd there to resume it", "exit\r"],
				],
			}),
		);
		expect(words(chat)).toContain(`this session belongs to ${w.beta} — cd there to resume it`);
		// still in this project's folder, never switched
		expect(existsSync(join(w.folder(w.alpha), "pp-beta.jsonl"))).toBe(false);
	}, 90_000);
});
