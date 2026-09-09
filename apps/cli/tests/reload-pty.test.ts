/**
 * §2.5 — `/reload` rereads extensions, skills and config into a live
 * session.
 *
 * Reload is a REBUILD, not a mutation. The tempting shape is to swap the
 * contents of the extensions array the runtime already holds by
 * reference, and it reloads exactly half the surface: `run.ts` composes
 * the system prompt and the approval chain per run, but the tool registry
 * is built once in the agent's constructor and has no unregister, and
 * hooks are frozen into the session's config. A prompt that announces a
 * skill whose tool is not in the table is the DC-19 family — a change
 * that appears to happen and did not.
 *
 * So the agent is constructed again against the same session id, whose
 * truth is the durable log on disk. Nothing durable moves: a reload is
 * invisible in the record, because nothing the model said or did changes.
 *
 * The files these gates create appear MID-SESSION, through `!!` (§2.2) —
 * the session's own shell gesture. `delays` carries strings to the pty
 * driver and cannot carry a callback, and writing the files before the
 * process starts would prove nothing: the whole claim is that they were
 * not there when the session was built.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** Every gate asserts this FIRST. Without it each one passes on a tree
 *  where `/reload` is an unknown command: the trust question is asked
 *  once because nothing reloaded, the binding survives because nothing
 *  rebuilt it. A gate that is green before the feature exists is not a
 *  gate — three of these were, on the first red run. */
function reloaded(out: string, times = 1): void {
	expect(out, "the command exists at all").not.toContain("unknown command: /reload");
	expect(out.split("[reload]").length - 1, `the reload ran ${times}×`).toBeGreaterThanOrEqual(times);
}

/** A `!!` line that writes a SKILL.md the index will accept — the `\n`s
 *  are printf's, so they must survive as two characters through the feed. */
function writeSkillCmd(skillsDir: string, name: string, mark: string): string {
	// base64, so the BODY IS NOT IN THE COMMAND. The first version of this
	// gate printf'd the body and then asserted the body was on screen — it
	// was, in the echo of the command that wrote it, on a tree where
	// `/reload` did not exist. The encoded form makes the plaintext
	// reachable only through read_skill's result.
	// The MARK rides the description, which is line 3 — the tool card
	// previews the first few lines of a result (R13), so a token in the body
	// on line 6 is cut and an assertion on it fails against a working
	// feature. That is what the first run of this gate did.
	const md = `---\nname: ${name}\ndescription: ${mark}\n---\n\nthe skill's instructions\n`;
	const b64 = Buffer.from(md, "utf8").toString("base64");
	return `!!mkdir -p ${skillsDir}/${name} && printf %s ${b64} | base64 -d > ${skillsDir}/${name}/SKILL.md\r`;
}

/** An extension contributing ONE tool that answers with a fixed word. */
function extensionWithTool(dir: string, file: string, tool: string, answer: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, file),
		[
			"export default {",
			`  name: ${JSON.stringify(file.replace(/\.mjs$/, ""))},`,
			"  tools: [{",
			`    name: ${JSON.stringify(tool)},`,
			'    description: "a probe",',
			'    parameters: { type: "object", properties: {}, additionalProperties: false },',
			`    execute: async () => ({ content: ${JSON.stringify(answer)}, isError: false }),`,
			"  }],",
			"};",
			"",
		].join("\n"),
		"utf8",
	);
}

function skillDir(root: string, name: string, mark: string): void {
	mkdirSync(join(root, name), { recursive: true });
	writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${mark}\n---\n\nthe skill's instructions\n`, "utf8");
}

describe("§2.5 — /reload", () => {
	it("gate 1 — a skill added mid-session is in the index AND its tool can read it", () => {
		// The gate that decides the shape: every in-place design passes the
		// first half and fails the second, because read_skill closes over
		// the index it was built with and the registry takes no replacement.
		// A session that started with NO skills gets an extension with no
		// tools at all, so there is not even a live source to update.
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "text_delta", text: "before." }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "tool_call_end", callId: "s1", name: "read_skill", input: { name: "greet" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "after." }, { type: "stop", reason: "end_turn" }] },
				...spares(3),
			]),
		});
		const raw = ptyRun(["--mode", "bypass", "reload-skill"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["before.", writeSkillCmd(dirs.skills, "greet", "SKILL-ADDED-AFTER-START")],
			],
			delays: [
				[9, "/reload\r"],
				[15, "use it\r"],
				[22, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out);
		expect(out, "the TOOL read the file — not merely the prompt naming it").toContain("SKILL-ADDED-AFTER-START");
		expect(out, "the skill was not reported unknown").not.toContain('unknown skill "greet"');
	}, 300_000);

	it("gate 2 — an extension deleted mid-session stops being callable", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "tool_call_end", callId: "p1", name: "probe_tool", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "first done." }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "tool_call_end", callId: "p2", name: "probe_tool", input: {} }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "second done." }, { type: "stop", reason: "end_turn" }] },
				...spares(3),
			]),
		});
		extensionWithTool(dirs.extensions, "probe.mjs", "probe_tool", "PROBE ANSWERED");
		const raw = ptyRun(["--mode", "bypass", "reload-drop"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/ commands · ↑ history", "call it\r"],
				["first done.", `!!rm -f ${join(dirs.extensions, "probe.mjs")}\r`],
			],
			delays: [
				[10, "/reload\r"],
				[16, "call it again\r"],
				[23, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out);
		expect(out, "it answered while the extension was installed").toContain("PROBE ANSWERED");
		const afterReload = out.slice(out.lastIndexOf("/reload"));
		expect(afterReload, "and not after it was deleted — the registry is a new one").not.toContain("PROBE ANSWERED");
	}, 300_000);

	it("gate 3 — a broken extension leaves the session alive on the previous set", () => {
		// loadExtensions is deliberately loud, so the order cannot be
		// tear-down-then-load: a typo would leave the session with no agent
		// and no way back. Load first, swap only on success.
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "text_delta", text: "before." }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "text_delta", text: "STILL ALIVE" }, { type: "stop", reason: "end_turn" }] },
				...spares(3),
			]),
		});
		const raw = ptyRun(["--mode", "bypass", "reload-broken"], env as NodeJS.ProcessEnv, {
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["before.", `!!printf 'throw new Error("deliberately broken");\\n' > ${join(dirs.extensions, "broken.mjs")}\r`],
			],
			delays: [
				[9, "/reload\r"],
				[15, "still there?\r"],
				[22, "exit\r"],
			],
		});
		const out = strip(raw);
		expect(out, "the command exists at all").not.toContain("unknown command: /reload");
		expect(out, "the failure is stated, not swallowed").toContain("broken.mjs");
		expect(out, "and it says what is still true").toContain("still in force");
		expect(out, "the session did not die with it").toContain("STILL ALIVE");
	}, 300_000);

	it("gate 4 — a model switched mid-session survives the reload", () => {
		// The rebuild takes the LIVE binding and there is no second source:
		// modelFlag is not threaded into the loop at all. Two sources for
		// the model is exactly how the effort-axis revert happened.
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(spares(6)) });
		writeFileSync(
			join(dirs.home, "config.json"),
			`${JSON.stringify({
				models: {
					alpha: { kind: "openai-compat", model: "model-alpha", apiKeyEnv: "RELOAD_KEY", baseUrl: "http://127.0.0.1:9" },
					beta: { kind: "openai-compat", model: "model-beta", apiKeyEnv: "RELOAD_KEY", baseUrl: "http://127.0.0.1:9" },
				},
			})}\n`,
			"utf8",
		);
		const raw = ptyRun(["chat", "reload-model"], { ...env, RELOAD_KEY: "fake" } as NodeJS.ProcessEnv, {
			feeds: [["/ commands · ↑ history", "/model beta\r"]],
			delays: [
				[6, "/reload\r"],
				[13, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out);
		const after = out.slice(out.lastIndexOf("[reload]"));
		expect(after, "the switched binding came back").toContain("beta");
		expect(after, "and the startup profile did not silently return").not.toContain("model-alpha");
	}, 300_000);

	it("gate 5 — the skills merge reads the ORIGINAL user dir, not the merge it made last time", () => {
		// applySkillsMerge symlinks user + project skills into a temp dir and
		// then points KISO_SKILLS_DIR at it. Read twice, that is a loop: the
		// second merge takes the FIRST merge as its user dir. A skill deleted
		// from the real user directory would survive forever, and each reload
		// would add a temp directory the previous one's symlinks depend on —
		// so it could never be cleaned. This tree has already lost an
		// afternoon to 449,956 stale temp directories.
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "tool_call_end", callId: "k1", name: "read_skill", input: { name: "kept" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "kept read." }, { type: "stop", reason: "end_turn" }] },
				{ events: [{ type: "tool_call_end", callId: "d1", name: "read_skill", input: { name: "doomed" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "doomed asked." }, { type: "stop", reason: "end_turn" }] },
				...spares(4),
			]),
		});
		skillDir(dirs.skills, "doomed", "DOOMED-USER-SKILL");
		const workdir = mkdtempSync(join(tmpdir(), "kiso-reload-sk-"));
		skillDir(join(workdir, ".kiso", "skills"), "kept", "KEPT-PROJECT-SKILL");
		const raw = ptyRun(["--mode", "bypass", "reload-merge"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			timeout: 110,
			feeds: [
				["trust this project's .kiso?", "y\r"],
				["/ commands · ↑ history", `!!rm -rf ${join(dirs.skills, "doomed")}\r`],
			],
			delays: [
				[9, "/reload\r"],
				[16, "/reload\r"],
				[23, "read kept\r"],
				[32, "read doomed\r"],
				[41, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out, 2);
		expect(out, "the project skill still merges after two reloads").toContain("KEPT-PROJECT-SKILL");
		expect(out, "the deleted user skill is gone — the merge read the real source, not its own last output").toContain('unknown skill "doomed"');
	}, 360_000);

	it("gate 6 — a project whose trust was DECLINED is not asked about again", () => {
		const { env } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(spares(6)) });
		const workdir = mkdtempSync(join(tmpdir(), "kiso-reload-proj-"));
		extensionWithTool(join(workdir, ".kiso", "extensions"), "proj.mjs", "proj_tool", "PROJECT TOOL");
		const raw = ptyRun(["--mode", "bypass", "reload-trust"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [["trust this project's .kiso?", "n\r"]],
			delays: [
				[8, "/reload\r"],
				[15, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out);
		const asks = out.split("trust this project's .kiso?").length - 1;
		expect(asks, "asked once — the reload did not re-put a question already answered").toBe(1);
	}, 300_000);

	it("gate 7 — a don't-ask-again rule granted AFTER a reload is live, and survives the next one", () => {
		// The hazard the cache-busting loader creates. The W21 writer made a
		// rule live by re-importing the plain file URL and mutating the
		// exported Set, on the stated assumption that a file the loader
		// imported is ONE namespace. Under a per-load nonce the loader holds
		// `file?load=N` and that import is the startup namespace: the human
		// clicks don't-ask-again and is asked again on the very next call.
		const call = (id: string) => ({
			events: [{ type: "tool_call_end", callId: id, name: "shell", input: { command: "echo ruled" } }, { type: "stop", reason: "tool_use" }],
		});
		const said = (t: string) => ({ events: [{ type: "text_delta", text: t }, { type: "stop", reason: "end_turn" }] });
		// Two SUBMITTED turns, four script entries: a turn that calls a tool
		// spends one entry on the call and one on the answer. `/reload` is a
		// command and spends none — which is the first thing to check when a
		// faux script looks off by one.
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([call("a1"), said("GRANTED-AND-RAN"), call("a2"), said("STILL-RULED-AFTER-RELOAD"), ...spares(4)]),
		});
		const raw = ptyRun(["chat", "reload-rule"], env as NodeJS.ProcessEnv, {
			// default mode: shell ASKS
			feeds: [
				["/ commands · ↑ history", "/reload\r"], // reload FIRST — the rule is granted on a rebuilt agent
				["don't ask again", "2"], // grant it
			],
			timeout: 110,
			delays: [
				[16, "again\r"], // must NOT ask
				[25, "/reload\r"], // and it must come back from the file
				[34, "third\r"],
				[45, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out, 2);
		const afterGrant = out.slice(out.indexOf("don't ask again") + 24);
		expect(afterGrant, "the rule was live immediately — no second question").not.toContain("don't ask again");
		expect(existsSync(join(dirs.extensions, "dont-ask-again.mjs")), "and it was persisted").toBe(true);
		expect(out, "the grant took effect on the turn that asked for it").toContain("GRANTED-AND-RAN");
		expect(out, "and the rule came back from the FILE across the second reload").toContain("STILL-RULED-AFTER-RELOAD");
	}, 360_000);
});
