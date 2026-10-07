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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const strip = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

/** RE-DERIVED (the last sweep, owner 2026-10-06): on a dock `[reload] …`
 *  is a sentence without its brackets — `reloaded 4 extensions, …`, and a
 *  failure `reload failed: …`. A pipe still prints `[reload]`. */
const RELOADED = "reloaded ";

/** Every gate asserts this FIRST. Without it each one passes on a tree
 *  where `/reload` is an unknown command: the trust question is asked
 *  once because nothing reloaded, the binding survives because nothing
 *  rebuilt it. A gate that is green before the feature exists is not a
 *  gate — three of these were, on the first red run. */
function reloaded(out: string, times = 1): void {
	expect(out, "the command exists at all").not.toContain("unknown command: /reload");
	expect(out.split(RELOADED).length - 1, `the reload ran ${times}×`).toBeGreaterThanOrEqual(times);
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
	return `!!mkdir -p ${skillsDir}/${name} && printf %s ${b64} | base64 -d > ${skillsDir}/${name}/SKILL.md${doneEcho(SHELL_DONE)}\r`;
}

/** The completion marker for a `!!` line.
 *
 *  These gates used to wait on the CLOCK — `[9, "/reload\r"]` meant "nine
 *  seconds ought to be enough for the shell command". Ten scenarios of
 *  that is 277 of this file's 278 seconds, spent waiting for things that
 *  had already happened.
 *
 *  A feed needs a needle, and the obvious one — the command's own text —
 *  is wrong: the composer ECHOES what is typed, so the needle fires
 *  before the command runs. Same trap the mark in `writeSkillCmd` was
 *  built to dodge. So the marker travels base64-encoded and is decoded by
 *  the command itself: the plaintext exists only in the shell block the
 *  CLI prints AFTER the command finished. */
const SHELL_DONE = "BANG-COMMAND-FINISHED";
const DONE_A = "BANG-A-FINISHED";
const DONE_B = "BANG-B-FINISHED";
function doneEcho(mark: string): string {
	return ` && printf %s ${Buffer.from(mark, "utf8").toString("base64")} | base64 -d`;
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

/** RELOAD-R1 (Astra): a `!!` line that makes the NEXT reload distinguishable.
 *
 *  Consecutive reloads printed the same line, so the gates keyed the next
 *  step on a marker that was already on screen and counted SUBSTRINGS of a
 *  repainted stream. Gate 8 asked for three reloads, got two, saw the
 *  success text drawn three times by the compositor, and passed; gate 5's
 *  reads ran before the second rebuild finished. Ordered input delivery is
 *  not ordered completion: `/reload` resolves the chat-end signal and the
 *  rebuild happens on the turn chain, so two immediate requests can
 *  coalesce.
 *
 *  Adding an extension changes the COUNT the reload reports, so each one
 *  announces itself with a line no earlier reload could have produced. A
 *  repaint of `2 extensions` still proves the third reload ran with two
 *  present; a coalesced or omitted reload cannot produce that line at all. */
function addExtensionCmd(dir: string, name: string, mark: string): string {
	const mod = `export default { name: ${JSON.stringify(name)}, tools: [] };\n`;
	const b64 = Buffer.from(mod, "utf8").toString("base64");
	return `!!mkdir -p ${dir} && printf %s ${b64} | base64 -d > ${dir}/${name}.mjs${doneEcho(mark)}\r`;
}

/** The reload line names its own extension count — the only part of it that
 *  differs between consecutive reloads in these gates.
 *
 *  BASELINE is what a reload reports in THESE gates before anything is
 *  added, measured by dumping their own screens — not guessed, and not
 *  measured somewhere else. Two earlier numbers were wrong for instructive
 *  reasons: 0 (pure invention: both gates stalled, loudly, naming the
 *  needle that never appeared), then 3 (a bare CLI probe WITHOUT
 *  isolatedEnv, which installs one — a fixture easier than the world, and
 *  the count it produced slid the feed chain by one so two reloads ran
 *  where three were asked for, which is exactly the defect being repaired
 *  and which the new assertion caught).
 *
 *  If the kernel's own extension set changes, these gates go red naming
 *  the needle that never appeared, and the fix is this one number. That is
 *  a thing someone should look at. */
const BASELINE = 4;
const reloadWith = (added: number): string => `${RELOADED}${BASELINE + added} extensions`;

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
				["/mode to switch", "go\r"],
				["before.", writeSkillCmd(dirs.skills, "greet", "SKILL-ADDED-AFTER-START")],
				// each step waits for the PREVIOUS one to have happened,
				// not for a number of seconds to pass
				[SHELL_DONE, "/reload\r"],
				[RELOADED, "use it\r"],
				["after.", "exit\r"],
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
				["/mode to switch", "call it\r"],
				["first done.", `!!rm -f ${join(dirs.extensions, "probe.mjs")}${doneEcho(SHELL_DONE)}\r`],
				[SHELL_DONE, "/reload\r"],
				[RELOADED, "call it again\r"],
				["second done.", "exit\r"],
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
				["/mode to switch", "go\r"],
				["before.", `!!printf 'throw new Error("deliberately broken");\\n' > ${join(dirs.extensions, "broken.mjs")}${doneEcho(SHELL_DONE)}\r`],
				[SHELL_DONE, "/reload\r"],
				["reload failed", "still there?\r"],
				["STILL ALIVE", "exit\r"],
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
			feeds: [
				["/mode to switch", "/model beta\r"],
				["model-beta", "/reload\r"],
				[RELOADED, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out);
		const after = out.slice(out.lastIndexOf(RELOADED));
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
				["trust this project", "y\r"],
				["/mode to switch", `!!rm -rf ${join(dirs.skills, "doomed")}${doneEcho(SHELL_DONE)}\r`],
				[SHELL_DONE, "/reload\r"],
				// ONE reload at a time, each awaited on a line the previous
				// one could not have printed
				[reloadWith(0), addExtensionCmd(dirs.extensions, "countable", DONE_A)],
				[DONE_A, "/reload\r"],
				[reloadWith(1), "read kept\r"],
				["kept read.", "read doomed\r"],
				["doomed asked.", "exit\r"],
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
			feeds: [["trust this project", "n\r"]],
			delays: [
				[8, "/reload\r"],
				[15, "exit\r"],
			],
		});
		const out = strip(raw);
		reloaded(out);
		const asks = out.split("trust this project").length - 1;
		expect(asks, "asked once — the reload did not re-put a question already answered").toBe(1);
	}, 300_000);

	it("gate 8 — RL-F4: the mcp merge reads the ORIGINAL user config, and its temp does not collide", () => {
		// RL-F1's sibling, one function up, found by the lead reviewing the
		// commit that fixed RL-F1. applyMcpMerge reads KISO_MCP_CONFIG and
		// then assigns the merged file to it, so a second merge takes the
		// first merged file — which already holds the project's servers — as
		// the user config, and the "exists in both" check throws for every
		// one of them. Every reload would fail, loudly and on the old set,
		// in exactly the projects that carry MCP servers.
		//
		// None of gates 1-7 has a project mcp.json, which is why seven green
		// gates did not see it. That is the finding under the finding.
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript(spares(8)) });
		rmSync(dirs.mcpConfig, { recursive: true, force: true }); // the helper leaves a placeholder DIR here
		writeFileSync(dirs.mcpConfig, JSON.stringify({ mcpServers: { userside: { command: "/bin/echo", args: ["u"] } } }), "utf8");
		const workdir = mkdtempSync(join(tmpdir(), "kiso-reload-mcp-"));
		mkdirSync(join(workdir, ".kiso"), { recursive: true });
		writeFileSync(join(workdir, ".kiso", "mcp.json"), JSON.stringify({ mcpServers: { projectside: { command: "/bin/echo", args: ["p"] } } }), "utf8");
		const raw = ptyRun(["--mode", "bypass", "reload-mcp"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			timeout: 110,
			feeds: [
				["trust this project", "y\r"],
				["/mode to switch", "/reload\r"],
				// three reloads, driven ONE AT A TIME. Each is awaited on a
				// line no earlier reload could have printed, because an
				// extension is added between them.
				[reloadWith(0), addExtensionCmd(dirs.extensions, "countable-a", DONE_A)],
				[DONE_A, "/reload\r"],
				[reloadWith(1), addExtensionCmd(dirs.extensions, "countable-b", DONE_B)],
				[DONE_B, "/reload\r"],
				[reloadWith(2), "exit\r"],
			],
		});
		const out = strip(raw);
		// the collision error is the loop's own signature: it can only fire
		// if the user side already contains the project's servers
		expect(out, "the merge never read its own output back as the user config").not.toContain("exists in both");
		// RELOAD-R1: COMPLETED OPERATIONS, not repaint occurrences. The
		// compositor redraws the success text, so counting substrings of the
		// byte stream overcounted — this gate saw three and two had run.
		// Each line below can only exist if the reload before it finished.
		for (const n of [0, 1, 2]) {
			expect(out, `reload ${n + 1} of 3 completed with ${n} extensions loaded`).toContain(reloadWith(n));
		}
	}, 360_000);

	it("gate 9 — RL-F5: a rule file written before this change keeps its rules through the first grant", () => {
		// The upgrade path RL-F2's fix opened. A file generated before §2.5
		// exports RULES and puts nothing on the extension, so `live.rules` is
		// undefined, the union starts from nothing, and the first new grant
		// rewrites the file with that grant ALONE — every rule the human
		// gave under 0.31.x, gone from disk, invisible in-session in exactly
		// the way RL-F2 was.
		const legacy = [
			'export const RULES = new Set(["read_file"]);',
			"",
			"export default {",
			'  name: "dont-ask-again",',
			"  approvals: [{ decide(call) { return RULES.has(call.name) ? { action: \"allow\" } : { action: \"abstain\" }; } }],",
			"};",
			"",
		].join("\n");
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "tool_call_end", callId: "g1", name: "shell", input: { command: "echo ruled" } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "granted." }, { type: "stop", reason: "end_turn" }] },
				...spares(4),
			]),
		});
		writeFileSync(join(dirs.extensions, "dont-ask-again.mjs"), legacy, "utf8");
		ptyRun(["chat", "reload-legacy"], env as NodeJS.ProcessEnv, {
			timeout: 110,
			feeds: [
				["/mode to switch", "go\r"],
				["don't ask again", "2"], // grant `shell` on top of the legacy `read_file`
				["granted.", "exit\r"],
			],
		});
		const after = readFileSync(join(dirs.extensions, "dont-ask-again.mjs"), "utf8");
		expect(after, "the rule granted now is on disk").toContain("shell");
		expect(after, "and the rule granted before the upgrade SURVIVED it").toContain("read_file");
	}, 360_000);

	it("gate 10 — RL-F6: a reload that fails LATE leaves the rule writer pointed at the live chain", () => {
		// The lead's review of 353a278 named this as a nit; it is reachable,
		// which makes it a finding. createCodingAgent publishes currentAgentExtensions
		// BEFORE createAgent, and createAgent throws on a tool-name collision
		// — a user extension exposing `read_file` is enough. So a failed
		// reload could leave the NEW array published beside the OLD agent,
		// whose config holds the old array by reference.
		//
		// The damage is RL-F3's family one level up: the don't-ask-again
		// writer mutates whatever currentAgentExtensions is, so a rule granted
		// after a failed reload would go into an array nothing reads. The
		// human clicks don't-ask-again and is asked again on the very next
		// identical call — the same symptom, a different orphaned object.
		//
		// The extension must appear MID-SESSION: present at startup it would
		// stop the session from starting at all, which is a different (and
		// already correct) behaviour.
		const call = (id: string) => ({
			events: [{ type: "tool_call_end", callId: id, name: "shell", input: { command: "echo ruled" } }, { type: "stop", reason: "tool_use" }],
		});
		const said = (t: string) => ({ events: [{ type: "text_delta", text: t }, { type: "stop", reason: "end_turn" }] });
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([call("c1"), said("GRANTED-AFTER-FAILURE"), call("c2"), said("STILL-RULED"), ...spares(4)]),
		});
		const mod = 'export default { name: "collide", tools: [{ name: "read_file", description: "x", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: "x", isError: false }) }] };\n';
		const b64 = Buffer.from(mod, "utf8").toString("base64");
		const raw = ptyRun(["chat", "reload-latefail"], env as NodeJS.ProcessEnv, {
			timeout: 130,
			feeds: [
				["/mode to switch", `!!printf %s ${b64} | base64 -d > ${join(dirs.extensions, "collide.mjs")}\r`],
				["don't ask again", "2"], // the grant, on the panel the first turn raises
			],
			delays: [
				[9, "/reload\r"], // fails: the collision is refused by the agent constructor
				[16, "go\r"], // the turn that asks
				[30, "again\r"], // must NOT ask — the rule has to have reached the LIVE chain
				// esc before exit, so the scenario ENDS in both worlds. On the
				// unfixed tree the second call raises a panel and `exit` would
				// be typed into it, and the run would wait out its whole wall
				// — a stall the harness reports instead of the assertion that
				// names the defect. The esc dismisses a panel if there is one
				// and costs nothing if there is not.
				[40, "\x1b"],
				[46, "exit\r"],
			],
		});
		const out = strip(raw);
		expect(out, "the reload FAILED, which is the precondition this gate needs").toContain("Tool already registered");
		expect(out, "and it failed the honest way").toContain("still in force");
		const afterGrant = out.slice(out.indexOf("don't ask again") + 24);
		expect(afterGrant, "the rule reached the chain the OLD agent actually reads").not.toContain("don't ask again");
		expect(out, "and the ruled turn ran").toContain("STILL-RULED");
	}, 360_000);

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
				["/mode to switch", "/reload\r"], // reload FIRST — the rule is granted on a rebuilt agent
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
