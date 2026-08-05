#!/usr/bin/env node
/**
 * kiso — the coding-agent reference product.
 *
 *   kiso chat [sessionId]   start or continue an interactive session
 *   kiso resume <sessionId> continue a session in one-shot mode
 *   kiso sessions           list durable sessions
 *
 * Provider selection (first match):
 *   ANTHROPIC_API_KEY      → Anthropic (ANTHROPIC_MODEL, default claude-sonnet-5)
 *   OPENAI_API_KEY         → OpenAI-compatible (OPENAI_MODEL, OPENAI_BASE_URL)
 *   neither                → faux mode: scripted model, zero keys, full CLI
 *
 * Sessions live under $KISO_HOME/sessions (default ~/.kiso/sessions) as
 * append-only JSONL. Write/edit/shell tools sit behind the approval policy:
 * the run pauses, asks, and resumes — durably (ADR-0024).
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createAgent,
	disposeExtensions,
	loadExtensions,
	loadProjectExtensions,
	projectArtifacts,
	recordTrust,
	SessionStore,
	trustFor,
	type AgentDefinition,
	type AgentSession,
	type ProjectArtifacts,
} from "@vincemakes/kiso-runtime";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import type { PermissionPolicy } from "@vincemakes/kiso-runtime";
import {
	escapeTerminal,
	foldResult,
	foldThinking,
	palette,
	renderEvent,
	renderSessionLine,
	renderStatusLine,
	renderTerminalGap,
	renderToolSummary,
	type RunUsage,
} from "./render.js";
import { Dock } from "./dock.js";

const PERMISSION_POLICY: PermissionPolicy = {
	rules: [
		{ tool: "read_file", action: "allow" },
		{ tool: "list_dir", action: "allow" },
		{ tool: "search_text", action: "allow" },
		{ tool: "write_file", action: "defer" },
		{ tool: "edit_file", action: "defer" },
		{ tool: "shell", action: "defer" },
	],
	default: "deny",
};

/** 发现#11: KISO_HOME is the ONE root — every default path derives from
 *  it (sessions, trust, extensions, mcp config, skills). The dedicated
 *  env vars (KISO_EXTENSIONS_DIR / KISO_MCP_CONFIG / KISO_SKILLS_DIR)
 *  still override their own path; nothing hard-codes ~/.kiso anymore. */
function kisoHome(): string {
	return process.env.KISO_HOME ?? join(homedir(), ".kiso");
}

function sessionsDir(): string {
	return join(kisoHome(), "sessions");
}

/** E1: the extension scan directory — KISO_EXTENSIONS_DIR overrides. */
function extensionsDir(): string {
	return process.env.KISO_EXTENSIONS_DIR ?? join(kisoHome(), "extensions");
}

/** E1: the extensions loaded by makeAgent — their names feed the banner. */
let loadedExtensions: readonly import("@vincemakes/kiso-runtime").KisoExtension[] = [];

/** E1: the USER-level extensions alone — the banner's unmarked part (E3:
 *  loadedExtensions later includes the project-level ones too). */
let userExtensions: readonly import("@vincemakes/kiso-runtime").KisoExtension[] = [];

/** E3: the PROJECT-level extensions (loaded after the trust gate) — the
 *  banner distinguishes them from the user-level ones. */
let projectExtensions: readonly import("@vincemakes/kiso-runtime").KisoExtension[] = [];

/** E3: temp artifacts of the mcp/skills merge — removed on exit. */
const mergedTempPaths: string[] = [];

/** The CLI's own version — read from the package.json next to the build. */
let VERSION = "?";
try {
	const pkg = JSON.parse(
		readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
	) as { version?: string };
	VERSION = pkg.version ?? "?";
} catch {
	// a packed CLI without a readable package.json still works
}

/** 横幅: the block-letter logo (design fixed). TTY only — pipes, e2e
 *  drivers, and CI see byte-for-byte the old output; the extensions line
 *  merges into the third row on TTY and stays a standalone line off-TTY.
 *  v2a: the logo rows stay dim; the TAGLINE (row 2) is the blue identity
 *  accent. */
const LOGO_TOP = "█ █ ▀█▀ █▀▀ █▀█\n█▀▄  █  ▀▀█ █ █   ";
const TAGLINE = "the coding agent that survives kill -9";
const LOGO_BOTTOM = "\n▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀";
function startupBanner(): string {
	// The historical `[N extensions: names]` text merges VERBATIM into the
	// third row — the existing e2e assertions keep matching (天然不破). E3:
	// project-level extensions are counted in N and listed after `project:`
	// — `[3 extensions: safe-defaults · project: lint-rules, mcp]`.
	const p = palette();
	const names = bannerExtensionText();
	return `${p.dim}${LOGO_TOP}${p.blue}${TAGLINE}${p.reset}${p.dim}${LOGO_BOTTOM}   v${VERSION}${names}${p.reset}\n`;
}

/** v2a: the interactive prompt — blue, the identity accent. readline owns
 *  the echo of what the user types; we own the prompt's color. */
function interactivePrompt(): string {
	const p = palette();
	return `${p.blue}you> ${p.reset}`;
}

/** v2b: the bottom-anchored UI — docked only on a color TTY; pipes and
 *  NO_COLOR stay the v2a line mode byte-for-byte. */
const dock = new Dock();

/** v2b: body output routes through the dock when docked (the cursor into
 *  the scroll region, then back to the input line); otherwise a plain
 *  write — pipes are byte-identical to v2a. */
function bodyWrite(text: string): void {
	if (dock.active) dock.writeBody(text);
	else process.stdout.write(text);
}

function bodyLog(text: string): void {
	bodyWrite(`${text}\n`);
}

/** v2b: the spinner merged into the STATUS BAR (the v2a standalone glyph
 *  is gone) — docked only, 200ms rotation between the request and the
 *  first event. */
function startStatusSpinner(): () => void {
	if (!dock.active) return () => {};
	const GLYPHS = ["◐", "◓", "◑", "◒"];
	let i = 0;
	const timer = setInterval(() => dock.setTail(GLYPHS[i++ % GLYPHS.length]!), 200);
	timer.unref();
	return () => dock.setTail("");
}

/** v2b: "running <tool> Ns" in the status bar while a tool executes. */
function startRunningTimer(name: string): () => void {
	if (!dock.active) return () => {};
	const started = Date.now();
	const timer = setInterval(() => dock.setTail(`running ${name} ${Math.round((Date.now() - started) / 1000)}s`), 1000);
	timer.unref();
	return () => {
		clearInterval(timer);
		dock.setTail("");
	};
}

/** The model name for the status bar — set by makeAgent. */
let agentModel = "faux";

/** E3: the `[N extensions: ...]` text — user-level names, then project-level
 *  ones marked with `project:`. Byte-identical to the historical text when
 *  no project extensions are loaded. */
function bannerExtensionText(): string {
	const total = userExtensions.length + projectExtensions.length;
	if (total === 0) return "";
	const parts: string[] = [];
	if (userExtensions.length > 0) parts.push(userExtensions.map((e) => e.name).join(", "));
	if (projectExtensions.length > 0) parts.push(`project: ${projectExtensions.map((e) => e.name).join(", ")}`);
	return ` · [${total} extension${total === 1 ? "" : "s"}: ${parts.join(" · ")}]`;
}

/** E1: the startup banner line(s) — TTY: logo + merged extensions; off-TTY:
 *  the historical `[N extensions: ...]` standalone line (zero change). */
function extensionsBanner(): void {
	if (process.stdout.isTTY) {
		bodyLog(startupBanner());
		return;
	}
	const text = bannerExtensionText();
	if (text === "") return;
	bodyLog(`${text}\n`);
}

/**
 * E3 — the project-level trust gate (ADR-0037): capability is trusted by
 * content digest, not by directory. Runs BEFORE any extension loads — the
 * mcp/skills merges must be in the env before the user-level extensions are
 * loaded (the mcp factory reads KISO_MCP_CONFIG at load time, the skills
 * extension scans KISO_SKILLS_DIR at load time).
 *
 * Verdicts: granted → load; refused → never load, never re-ask (refused is
 * sticky — re-evaluate by deleting the trust line or changing a file); no
 * record → only a HUMAN may decide, TTY only — non-TTY refuses with one
 * stderr line. Returns the artifacts on grant, null on anything else.
 */
async function resolveProjectTrust(): Promise<ProjectArtifacts | null> {
	const artifacts = await projectArtifacts(process.cwd());
	if (artifacts === null) return null; // no .kiso artifacts — nothing to gate
	const record = trustFor(artifacts.root, artifacts.digest);
	if (record?.decision === "granted") {
		applyProjectMerges(artifacts);
		return artifacts;
	}
	if (record?.decision === "refused") return null; // refused is sticky — no re-ask
	// First discovery — list every artifact (file name + digest short
	// prefix) and ask the human ONCE.
	if (!process.stdin.isTTY) {
		console.error(
			`[project .kiso] found ${artifacts.files.length} artifact(s) in ${artifacts.root} — not trusted, not loaded (run kiso interactively once to decide)`,
		);
		return null;
	}
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	// v2b: docked — the trust question takes over the status position.
	dock.bindInput(() => ({ line: rl.line, cursor: rl.cursor }), interactivePrompt());
	try {
		bodyLog(`[project .kiso] ${artifacts.root}`);
		for (const f of artifacts.files) {
			bodyLog(`  ${f.path}  (${f.digest.slice(0, 6)})`);
		}
		const answer = await ask(rl, `trust this project's .kiso? (y/n) `);
		const granted = answer !== CANCELLED && answer.trim().toLowerCase().startsWith("y");
		recordTrust({ root: artifacts.root, digest: artifacts.digest, decision: granted ? "granted" : "refused" });
		if (!granted) return null;
		applyProjectMerges(artifacts);
		return artifacts;
	} finally {
		rl.close();
	}
}

/**
 * E3 — merge the project's mcp.json and skills into the env BEFORE the
 * extension load. A server name in BOTH configs is a LOUD error (a silent
 * override would be a supply-chain surprise); a skill name in both merges
 * with project-wins and a stderr note. Exported for tests.
 */
export function applyProjectMerges(artifacts: ProjectArtifacts): void {
	if (artifacts.files.some((f) => f.kind === "mcp")) applyMcpMerge(artifacts.root);
	if (artifacts.files.some((f) => f.kind === "skill")) applySkillsMerge(artifacts.root);
}

/** Read an mcp.json with the mcp extension's tolerance: absent/unreadable →
 *  {}, present-but-broken → throw (the loader convention). */
function readMcpConfig(path: string): { mcpServers?: Record<string, unknown> } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`[project .kiso] cannot parse ${path}: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`[project .kiso] ${path} must be an object with an mcpServers map`);
	}
	return parsed as { mcpServers?: Record<string, unknown> };
}

/** Merge user-level + project-level mcp.json into one temp file and point
 *  KISO_MCP_CONFIG at it — the mcp extension reads it at load time. */
function applyMcpMerge(root: string): void {
	const userPath = process.env.KISO_MCP_CONFIG ?? join(kisoHome(), "mcp.json");
	const user = readMcpConfig(userPath);
	const project = readMcpConfig(join(root, "mcp.json"));
	const userServers = user.mcpServers ?? {};
	const projectServers = project.mcpServers ?? {};
	if (Object.keys(projectServers).length === 0) return; // nothing to merge
	for (const name of Object.keys(projectServers)) {
		if (name in userServers) {
			throw new Error(`[project .kiso] mcp server "${name}" exists in both the user-level and the project-level mcp.json`);
		}
	}
	const merged = { mcpServers: { ...userServers, ...projectServers } };
	const temp = join(tmpdir(), `kiso-mcp-merged-${process.pid}.json`);
	writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	process.env.KISO_MCP_CONFIG = temp;
	mergedTempPaths.push(temp);
}

/** Merge user-level + project-level skills into one temp scan dir (project
 *  skill dirs symlinked first; a name in both → project wins + a stderr
 *  note) and point KISO_SKILLS_DIR at it — the skills extension's existing
 *  scan reads it at load time and per read_skill call. */
function applySkillsMerge(root: string): void {
	const userDir = process.env.KISO_SKILLS_DIR ?? join(kisoHome(), "skills");
	const projectDir = join(root, "skills");
	const merged = mkdtempSync(join(tmpdir(), "kiso-skills-"));
	mergedTempPaths.push(merged);
	for (const dir of readdirSyncSafe(projectDir)) {
		symlinkSync(join(projectDir, dir), join(merged, dir)); // project wins on collision
	}
	for (const dir of readdirSyncSafe(userDir)) {
		const target = join(merged, dir);
		if (existsSync(target)) {
			console.error(`[project .kiso] skill "${dir}" exists in both user and project skills — project wins`);
			continue;
		}
		symlinkSync(join(userDir, dir), target);
	}
	process.env.KISO_SKILLS_DIR = merged;
}

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return []; // no skills dir on either level = nothing to merge
	}
}

/**
 * A 区: the coding-agent system prompt — ONE constant, byte-stable for the
 * session's lifetime (D 区). Kept under ~80 lines; no template engine.
 */
const SYSTEM_PROMPT = `You are kiso, a coding agent. You work in a workspace
directory and change code with tools. Be concise: answer in a few lines
unless the task genuinely needs more. Never claim a file was changed
unless a tool confirmed it.

Tool discipline:
- READ BEFORE YOU EDIT. For any file you are about to change, read it
  first — never guess its content.
- Use edit_file for targeted changes and write_file for full rewrites.
  Prefer many small edits over one large write.
- shell is for commands: builds, tests, git, grep. Be careful — shell has
  side effects and may take time. Run one command at a time and inspect
  the output before continuing.
- search_text and list_dir are cheap — use them to orient before reading
  whole files.
- When a tool fails, read the error and adjust; do not repeat the same
  call blindly.

Workflow: understand the request, find the relevant code, make the
smallest change that works, then verify with a command (tests/build).
Report what you did in one or two lines per change.`;

/** The project-instructions file names, in priority order (A 区). */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Hard cap for injected instructions — truncate and say so. */
const INSTRUCTION_MAX = 8 * 1024;

/**
 * A 区: read the FIRST present instruction file (AGENTS.md preferred) and
 * return it as an injected section, or "" when none exists. Truncated at
 * 8KB with an explicit note. Pure — read once per session, so the prompt
 * is byte-stable for the session's lifetime.
 */
export function readProjectInstructions(cwd: string): string {
	for (const name of INSTRUCTION_FILES) {
		let text: string;
		try {
			text = readFileSync(join(cwd, name), "utf8");
		} catch {
			continue; // not present — try the next
		}
		const body = text.length > INSTRUCTION_MAX ? text.slice(0, INSTRUCTION_MAX) + `\n\n[truncated at ${INSTRUCTION_MAX} chars]` : text;
		return `\n\n=== Project instructions (${name}) ===\n${body}`;
	}
	return "";
}

/** A 区: the session's system prompt — the constant plus any project
 *  instructions found in the workspace. Deterministic per cwd. */
export function composeSystemPrompt(cwd: string): string {
	const injected = readProjectInstructions(cwd);
	return injected === "" ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${injected}`;
}

/**
 * E 区: how many faux-script turns a session has already consumed. The faux
 * provider's script counter is per-process, so a FRESH process that resumes
 * a session would restart the script at turn 0 — re-issuing the first
 * scripted call instead of continuing the trajectory. The session log is
 * the durable position: a turn is consumed when it produced a tool_result
 * or an end_turn stop — AND when its tool call is unfinished (started but
 * no result): the recovery completes those turns WITHOUT a provider call
 * (executes the approved call, or fills the human verdict), so the model's
 * next response is the turn AFTER them.
 */
function fauxSkip(id: string): number {
	const events = new SessionStore(sessionsDir())
		.load(id)
		.map((r) => r.event);
	const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => e.callId));
	return (
		events.filter((e) => e.type === "tool_result").length +
		events.filter((e) => e.type === "stop" && e.reason === "end_turn").length +
		events.filter((e) => e.type === "tool_call_end" && !results.has(e.callId)).length
	);
}

async function makeAgent(fauxSkipTurns = 0) {
	const store = new SessionStore(sessionsDir());

	// E3: the project-level trust gate runs BEFORE any extension load (the
	// mcp/skills merges must be in the env when the user-level extensions
	// load). Untrusted project capability is never loaded — never silently.
	const project = await resolveProjectTrust();
	// E1: the startup extension scan — a broken extension fails the process
	// LOUDLY here (loadExtensions throws), never silently.
	userExtensions = await loadExtensions(extensionsDir());
	if (project !== null) {
		projectExtensions = await loadProjectExtensions(process.cwd(), userExtensions);
		loadedExtensions = [...userExtensions, ...projectExtensions];
	} else {
		projectExtensions = [];
		loadedExtensions = userExtensions;
	}

	// Provider wiring (F 组): the CLI never imports provider SDKs directly —
	// the runtime's lazy provider resolution owns them. Real key → real
	// provider; none → faux.
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;

	let provider: "anthropic" | "openai-compat" | undefined;
	let model: string;
	if (anthropicKey) {
		provider = "anthropic";
		model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
	} else if (openaiKey) {
		provider = "openai-compat";
		model = process.env.OPENAI_MODEL ?? "gpt-4o";
	} else {
		console.log("[faux mode — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model]\n");
		model = "faux";
	}
	agentModel = model; // v2b: the status bar shows it

	const definition: AgentDefinition = {
		model,
		store,
		// Area 5: the coding tools are bound to the workspace — every path
		// they touch is canonicalized inside cwd, escapes are refused.
		tools: [...createCodingTools({ workspaceRoot: process.cwd() })],
		permissionPolicy: PERMISSION_POLICY,
		systemPrompt: composeSystemPrompt(process.cwd()),
		// C 区: microcompact is ON by default in the product — threshold =
		// half the model window (KISO_CONTEXT_WINDOW override included;
		// 200k window → 100k tokens). Long sessions compact old read/list/
		// search/shell outputs instead of silently growing past the window.
		microcompact: { thresholdTokens: contextWindowTokens() / 2 },
		maxTurns: 20,
		extensions: loadedExtensions,
		...(provider !== undefined
			? {
					provider,
					apiKey: (anthropicKey ?? openaiKey) as string,
					...(process.env.OPENAI_BASE_URL !== undefined ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
				}
			: { adapter: createFauxProvider(readFauxScript().slice(fauxSkipTurns)) }),
	};
	return createAgent(definition);
}

/**
 * E 区: KISO_FAUX_SCRIPT=<path> overrides the demo script with a JSON
 * FauxScript file — the kill -9 e2e drives the CLI through an exact
 * multi-tool trajectory. Absent → the built-in demo script.
 */
function readFauxScript(): FauxScript {
	const path = process.env.KISO_FAUX_SCRIPT;
	if (path === undefined) return fauxScript();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as FauxScript;
		if (!Array.isArray(parsed)) throw new Error("not an array");
		return parsed;
	} catch (err) {
		console.error(`[KISO_FAUX_SCRIPT] cannot load ${path}: ${(err as Error).message}`);
		process.exit(1);
	}
}

/**
 * The keyless demo script: tours the tools so `kiso chat` exercises them.
 * FOUR turns: each user turn consumes two model rounds (call → result →
 * summary), so at least two consecutive user turns work in one process
 * (F 组).
 */
function fauxScript(): FauxScript {
	return [
		{
			events: [
				// 自举 P1: a multi-delta thinking block — renders as ONE
				// streaming segment, not one line per token.
				{ type: "thinking", text: "Let me think about" },
				{ type: "thinking", text: " the workspace" },
				{ type: "thinking", text: " before acting." },
				{ type: "text_start" },
				{ type: "text_delta", text: "I'm the faux model. Let me look at the working directory." },
				{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "I see the workspace. What would you like me to inspect or change?" },
				{ type: "stop", reason: "end_turn" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "The faux model is still here, with full context." },
				{ type: "stop", reason: "end_turn" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "And this is the end of the scripted tour." },
				{ type: "stop", reason: "end_turn" },
			],
		},
	];
}
/** 十: a question cancelled by Ctrl+C — NEVER the empty string, which is a
 *  real user answer (the empty line). The empty answer and the cancellation
 *  are distinct facts. */
const CANCELLED = Symbol("kiso-question-cancelled");

/**
 * Ask the human a question. Non-interactive stdin (piped, CI) cannot wait
 * forever: approvals auto-deny and uncertain executions auto-abandon, both
 * printed loudly — never silently ignored, never hung (Area 7).
 *
 * 八/十: the question is ABORTABLE — a pending rl.question is registered in
 * `pendingAsk` and the SIGINT handler resolves it with the CANCELLED
 * sentinel. The rl.question callback is NOT left dangling: an input that
 * arrives after the cancellation is re-emitted as a fresh "line" — it
 * becomes the next user turn instead of being swallowed by the dead
 * question.
 */
let pendingAsk: (() => void) | null = null;
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string | typeof CANCELLED> {
	if (!process.stdin.isTTY) {
		console.log(`[non-interactive — no human to ask: ${question}]`);
		return Promise.resolve("");
	}
	// v2b: docked — the question takes over the status position, the
	// answer lands at the input line.
	if (dock.active) dock.showQuestion(question);
	return new Promise((resolve) => {
		let settled = false;
		pendingAsk = () => {
			if (settled) return;
			settled = true;
			pendingAsk = null;
			resolve(CANCELLED); // the run is aborting — the question is dead
		};
		rl.question(dock.active ? "" : question, (answer) => {
			if (settled) {
				// The question was cancelled; this line is a NEW user turn.
				rl.emit("line", answer);
				return;
			}
			settled = true;
			pendingAsk = null;
			if (dock.active) dock.clearQuestion();
			resolve(answer);
		});
	});
}

/**
 * C 区: the model window in tokens — KISO_CONTEXT_WINDOW overrides the
 * 200k default. The microcompact threshold is derived from it (50%), and
 * the status line's ~ctx estimate is measured against it — one source of
 * truth for the window.
 */
function contextWindowTokens(): number {
	const window = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	return Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
}

/**
 * B 区: approximate context ratio — chars/4 of the projected messages vs
 * the model window. Marked ~ everywhere it is shown; no counting API.
 */
function estimateCtxRatio(session: AgentSession): number {
	const projected = session.projected();
	const chars = JSON.stringify(projected).length;
	return chars / 4 / contextWindowTokens();
}

/** Decide every uncertain execution with the human (r)erun/(a)bandon. */
async function resolveUncertains(
	session: AgentSession,
	rl: ReturnType<typeof createInterface>,
	isCancelled: () => boolean,
): Promise<void> {
	for (const uncertain of session.uncertainExecutions()) {
		const answer = await ask(
			rl,
			`⚠ interrupted execution: ${escapeTerminal(uncertain.name)} (${uncertain.executionId}) — did it apply? (r)erun / (a)bandon: `,
		);
		if (isCancelled() || answer === CANCELLED) {
			// 十: a cancellation NEVER records a verdict — the execution
			// stays uncertain and durable; no rerun/abandoned is fabricated.
			return;
		}
		const resolution = answer.trim().toLowerCase().startsWith("r") ? "rerun" : "abandoned";
		await session.resolveUncertain(uncertain.executionId, resolution);
		console.log(`  ${resolution}\n`);
	}
}

/** B 区: the last completed tool call, for the /last slash command. */
interface LastToolCall {
	readonly name: string;
	readonly input: Record<string, unknown>;
	readonly result: { content: string; isError: boolean };
}

/** B 区: default context window for the ~ctx estimate (config overridable). */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Consume a run, answering approval pauses as they arrive. `resumeMode`
 * marks a session.resume() continuation. v2a: `faux` picks the status
 * line's form; `liveInput` (non-null only in interactive chat) carries the
 * last line THIS process's readline consumed — the double-echo filter.
 */
async function consumeRun(
	session: AgentSession,
	run: AsyncIterable<import("@vincemakes/kiso-core").Event>,
	rl: ReturnType<typeof createInterface>,
	turnNo: number,
	lastToolRef: { current: LastToolCall | null },
	faux: boolean,
	liveInput: { current: string | null } | null,
	lastThinking: { current: string | null },
	statusCb: ((usage: RunUsage, ctxRatio: number) => void) | null,
): Promise<import("@vincemakes/kiso-core").Event | undefined> {
	let last: import("@vincemakes/kiso-core").Event | undefined;
	// B 区: tool_call_end → (name, input) for the summary; tool_result →
	// one summary line. Usage events feed the status line.
	const pendingCalls = new Map<string, { name: string; input: Record<string, unknown> }>();
	let usage: RunUsage = { in: null, out: null, cache: null, known: false };
	// v2b: thinking blocks buffer and fold to ONE dim line at the block's
	// end (foldThinking); the FULL text goes to /think.
	let thinkingBuf = "";
	const flushThinking = (): void => {
		if (thinkingBuf === "") return;
		lastThinking.current = thinkingBuf;
		bodyWrite(foldThinking(thinkingBuf));
		thinkingBuf = "";
	};
	let thinkingOpen = false;
	// v2b: liveness merged into the status bar (docked); a running timer
	// shows "running <tool> Ns" during a tool execution.
	const stopSpinner = startStatusSpinner();
	let stopRunning: (() => void) | null = null;
	let firstEvent = true;
	try {
	for await (const ev of run) {
		if (firstEvent) {
			firstEvent = false;
			stopSpinner();
		}
		last = ev;
		// v2a (双回显): the interactive readline already echoed an input THIS
		// process consumed — rendering the event again is the double echo.
		// Replayed history (recovery/resume — nobody typed) keeps the event
		// render. Deterministic: exact content match with the consumed line,
		// on a TTY (the only place an echo exists to hand over).
		if (ev.type === "user_input" && liveInput !== null && liveInput.current === (typeof ev.content === "string" ? ev.content : "") && process.stdin.isTTY) {
			continue;
		}
		const prevThinking = thinkingOpen;
		thinkingOpen = ev.type === "thinking";
		if (prevThinking && !thinkingOpen) flushThinking();
		if (ev.type === "thinking") {
			thinkingBuf += ev.text;
			continue;
		}
		if (ev.type === "tool_call_end") {
			pendingCalls.set(ev.callId, { name: ev.name, input: ev.input ?? {} });
		}
		if (ev.type === "tool_execution_started") {
			stopRunning = startRunningTimer(ev.name);
		}
		if (ev.type === "tool_result") {
			stopRunning?.();
			stopRunning = null;
			const call = pendingCalls.get(ev.callId);
			pendingCalls.delete(ev.callId);
			if (call !== undefined) {
				const text = typeof ev.content === "string" ? ev.content : "";
				lastToolRef.current = { name: call.name, input: call.input, result: { content: text, isError: ev.isError } };
				bodyLog(renderToolSummary(call.name, call.input, { content: text, isError: ev.isError }));
			}
		}
		if (ev.type === "usage") {
			usage = { in: ev.inputTokens, out: ev.outputTokens, cache: ev.cacheRead, known: ev.known };
			statusCb?.(usage, estimateCtxRatio(session));
		}
		if (ev.type === "uncertain_pending") {
			// 裁决 #12 (ADR-0038): the ⚠ line is pure INFORMATION now — the
			// approval chain guards retries, and the human question belongs
			// only to the crash window's recovery flow (resolveUncertains).
			// Old logs may still carry the event; replay shows the fact.
			bodyLog(
				`\n⚠ ${escapeTerminal(ev.name)} FAILED — the side effect may have applied.\n  ${escapeTerminal(ev.error)}\n`,
			);
			continue;
		}
		const rendered = renderEvent(ev, prevThinking);
		if (rendered.prompt) {
			// v2b (docked): the detail scrolls into the body; the question
			// takes over the status position; the answer lands at the input
			// line. Pipes keep the v2a inline render.
			bodyWrite(rendered.text);
			const decisionId = (ev as { decisionId: string }).decisionId;
			const name = (ev as { name: string }).name;
			// 八: the tool name is model text — escaped on every output path.
			const answer = await ask(rl, `approve ${escapeTerminal(name)}? (y/n) `);
			if (answer === CANCELLED) {
				// 十: a cancellation is a CONSERVATIVE denial, explicitly
				// distinguished from the user typing "n".
				bodyLog("[approval cancelled — treated as a denial]\n");
				await session.approve(decisionId, false);
				continue;
			}
			await session.approve(decisionId, answer.trim().toLowerCase().startsWith("y"));
		} else {
			bodyWrite(rendered.text);
		}
		if (ev.type === "terminal") {
			statusCb?.(usage, estimateCtxRatio(session));
			// v2a rhythm: the status line hugs the terminal (有什么显什么 —
			// null = nothing to show), then EXACTLY one blank line before
			// the next prompt.
			bodyWrite(renderTerminalGap(renderStatusLine(turnNo, usage, estimateCtxRatio(session), faux)));
		}
	}
	flushThinking();
	} finally {
		stopSpinner();
		stopRunning?.();
	}
	return last;
}

/** 十: a faux-mode run whose scripted turns are exhausted must NOT print a
 * provider error and exit 0 — the honest outcome is a loud message and a
 * non-zero exit. Thrown as a CONTROLLED exception (never process.exit):
 * the REPL closes, the error propagates through main's finally (so
 * agent.close() runs and no lock is left behind), and main's catch sets
 * the exit code. Only the exhaustion signature (the empty stream after
 * the declared turns) triggers the script-specific message; any other
 * error terminal still exits non-zero. */
class FauxExhaustionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FauxExhaustionError";
	}
}

function failOnFauxExhaustion(
	last: import("@vincemakes/kiso-core").Event | undefined,
	faux: boolean,
	rl: ReturnType<typeof createInterface> | undefined,
): void {
	if (!faux) return;
	if (last?.type !== "terminal" || last.outcome.kind !== "error") return;
	const message = last.outcome.error.message;
	rl?.close(); // the REPL must not stay open waiting for a line
	throw new FauxExhaustionError(
		message.startsWith("provider stream ended without a stop event")
			? "[faux mode] the scripted demo turns are exhausted — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model"
			: `[faux mode] the scripted model failed: ${escapeTerminal(message.slice(0, 200))}`,
	);
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
async function chat(session: AgentSession, faux: boolean): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;

	const turn = (input: string): Promise<void> =>
		new Promise((resolve, reject) => {
			// v2a: the echo filter compares the user_input event against THIS
			// turn's own input — lines that arrive ahead of their turn (piped
			// bursts, queued replays) must not overwrite the reference.
			liveInput.current = input;
			const run = session.run(input);
			currentRun = run;
			turnNo += 1;
			const myTurn = turnNo;
			(async () => {
				let last: import("@vincemakes/kiso-core").Event | undefined;
				try {
					last = await consumeRun(session, run, rl, myTurn, lastToolRef, faux, liveInput, lastThinking, statusCb);
					currentRun = null;
					// 八: a faux script that ran out of declared turns exits
					// loudly with a non-zero status — never a silent status 0.
					// 第四轮(对抗): the exhaustion is a CONTROLLED rejection of
					// this turn's promise — it propagates through the chain to
					// chat to main's finally/catch, never an orphaned
					// unhandled rejection from the IIFE.
					failOnFauxExhaustion(last, faux, rl);
					// 八: after EVERY turn the prompt is re-armed — the human
					// never types blind after the first turn.
					rl.setPrompt(interactivePrompt());
					rl.prompt();
					resolve();
				} catch (err) {
					// A run failure must not freeze the REPL (review finding
					// 11): surface it and re-arm the prompt.
					if (err instanceof FauxExhaustionError) {
						currentRun = null;
						reject(err);
						return;
					}
					console.error(`\n[run failed] ${err instanceof Error ? err.message : String(err)}\n`);
					currentRun = null;
					rl.setPrompt(interactivePrompt());
					rl.prompt();
					resolve();
				}
			})();
		});

	rl.on("SIGINT", () => {
		if (currentRun) {
			// 八: Ctrl+C cancels BOTH the pending question (if one is
			// awaiting a line) and the run — the run then writes its unique
			// aborted terminal, which the consumer keeps consuming.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (!cancelled) {
			cancelled = true;
			console.log("\n[exit requested]");
			pendingAsk?.(); // unblock a startup question
			rl.close();
		}
	});

	// 第五轮(P1-11): the PERSISTENT line listener is installed BEFORE the
	// startup recovery — a cancelled question's re-emitted "line" needs a
	// listener from the very first instant, or the input is silently lost.
	// Turns are SERIALIZED on a chain — piped lines arrive faster than
	// turns complete, and concurrent runs are forbidden. Lines that arrive
	// while the recovery is still running are QUEUED and replayed once the
	// REPL is ready (they are never dropped).
	let chain: Promise<void> = Promise.resolve();
	let replReady = false;
	const queuedLines: string[] = [];
	// B 区: user-turn counter for the status line, and the /last buffer.
	let turnNo = 0;
	const lastToolRef: { current: LastToolCall | null } = { current: null };
	// v2a: the last line THIS process's readline consumed — the double-echo
	// filter (see consumeRun). Only interactive chat sets it.
	const liveInput: { current: string | null } = { current: null };
	// v2b: the last complete thinking block, for /think.
	const lastThinking: { current: string | null } = { current: null };
	// v2b: the live status bar (docked only).
	const statusCb = (u: RunUsage, ctx: number): void => {
		if (!dock.active) return;
		const st = renderStatusLine(turnNo, u, ctx, faux);
		dock.setStatus(st === null ? `${session.id} · ${agentModel}` : `${session.id} · ${agentModel} · ${st}`);
	};
	dock.bindInput(() => ({ line: rl.line, cursor: rl.cursor }), interactivePrompt());
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (trimmed === "/help") {
			// Prints the available commands with one-line descriptions.
			// v2a: the command names are the blue identity accent.
			const p = palette();
			const cmd = (name: string, desc: string): string => `${p.blue}${name}${p.reset}    ${desc}`;
			chain = chain.then(async () => {
				bodyLog(cmd("/help", "print this list of commands"));
				bodyLog(cmd("/think", "show the last full thinking block"));
				bodyLog(cmd("/last", "show the most recent tool call's input and output"));
				bodyLog(cmd("/status", "show session id, event count, and context estimate"));
				bodyLog(cmd("exit", "leave the session"));
				rl.setPrompt(interactivePrompt());
				rl.prompt();
			});
			return;
		}
		if (trimmed === "/think") {
			// v2b: print the last COMPLETE thinking block — straight from the
			// event stream, nothing stored separately (the /last pattern).
			chain = chain.then(async () => {
				const t = lastThinking.current;
				if (t === null) {
					bodyLog("[no thinking yet]");
				} else {
					bodyLog(escapeTerminal(t));
				}
				rl.setPrompt(interactivePrompt());
				rl.prompt();
			});
			return;
		}
		if (trimmed === "/last") {
			// B 区: print the FULL input/output of the most recent tool call,
			// straight from the event stream — nothing is stored separately.
			// Runs on the chain: after any in-flight turn completes.
			chain = chain.then(async () => {
				const tool = lastToolRef.current;
				if (tool === null) {
					bodyLog("[no tool call yet]");
				} else {
					bodyLog(`--- ${tool.name} input ---`);
					bodyLog(escapeTerminal(JSON.stringify(tool.input, null, 2)));
					bodyLog(`--- ${tool.name} output${tool.result.isError ? " (error)" : ""} ---`);
					bodyLog(escapeTerminal(tool.result.content));
				}
				rl.setPrompt(interactivePrompt());
				rl.prompt();
			});
			return;
		}
		if (trimmed === "/status") {
			// B 区: session id, durable event count, and the ~ context
			// estimate — all read straight from the live session, nothing
			// stored separately. Runs on the chain after any in-flight turn.
			chain = chain.then(async () => {
				const ctxRatio = estimateCtxRatio(session);
				const ctx = Number.isFinite(ctxRatio) ? `~${Math.round(ctxRatio * 100)}%` : "~?";
				bodyLog(`session ${session.id}`);
				bodyLog(`${session.log.all.length} events`);
				bodyLog(`ctx ${ctx}`);
				rl.setPrompt(interactivePrompt());
				rl.prompt();
			});
			return;
		}
		if (trimmed === "exit" || trimmed === "") {
			rl.close();
			return;
		}
		if (!replReady) {
			queuedLines.push(line);
			return;
		}
		chain = chain.then(() => turn(line));
	});

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	// 八: the startup resume is bound to currentRun — Ctrl+C during it
	// aborts the recovery, exactly like the interactive turns.
	await resolveUncertains(session, rl, () => cancelled);
	if (!cancelled) {
		const recoveryRun = session.resume();
		currentRun = recoveryRun;
		turnNo += 1;
		const last = await consumeRun(session, recoveryRun, rl, turnNo, lastToolRef, faux, liveInput, lastThinking, statusCb);
		currentRun = null;
		failOnFauxExhaustion(last, faux, rl);
	}
	if (cancelled) {
		rl.close();
		await new Promise<void>((resolve) => rl.on("close", () => resolve()));
		return;
	}
	// The REPL is ready: replay anything that arrived during recovery.
	replReady = true;
	for (const line of queuedLines) {
		chain = chain.then(() => turn(line));
	}
	queuedLines.length = 0;
	rl.setPrompt(interactivePrompt());
	rl.prompt();
	await new Promise<void>((resolve) => rl.on("close", () => resolve()));
	await chain; // never exit while a turn is in flight
}

/**
 * Resume = the RECOVERY flow (Area 2/7): uncertain executions are decided,
 * the interrupted run is continued via session.resume() — never faked with
 * a new prompt. An optional prompt afterwards starts a genuinely new turn.
 * E 组: SIGINT aborts the run being resumed; every exit path closes the
 * session store so no lock is left behind.
 */
async function resume(session: AgentSession, prompt: string | undefined, faux: boolean): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;
	let turnNo = 0;
	const lastToolRef: { current: LastToolCall | null } = { current: null };
	const lastThinking: { current: string | null } = { current: null };
	// v2b: the live status bar (docked only).
	const statusCb = (u: RunUsage, ctx: number): void => {
		if (!dock.active) return;
		const st = renderStatusLine(turnNo, u, ctx, faux);
		dock.setStatus(st === null ? `${session.id} · ${agentModel}` : `${session.id} · ${agentModel} · ${st}`);
	};
	dock.bindInput(() => ({ line: rl.line, cursor: rl.cursor }), interactivePrompt());
	const withRun = async (run: ReturnType<AgentSession["resume"]>): Promise<void> => {
		currentRun = run;
		try {
			turnNo += 1;
			const last = await consumeRun(session, run, rl, turnNo, lastToolRef, faux, null, lastThinking, statusCb);
			failOnFauxExhaustion(last, faux, rl);
		} finally {
			currentRun = null;
		}
	};
	rl.on("SIGINT", () => {
		if (currentRun) {
			// 八: Ctrl+C cancels the pending question AND the run.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (!cancelled) {
			// 第四轮(对抗): also unblock a pending startup question — the
			// readline close alone would leave ask() hanging forever.
			// 第五轮(P2-2): the cancellation is recorded so the recovery is
			// NOT started afterwards — Ctrl+C exits cleanly.
			cancelled = true;
			console.log("\n[exit requested]");
			pendingAsk?.();
			rl.close();
		}
	});
	try {
		await resolveUncertains(session, rl, () => cancelled);
		if (!cancelled) {
			await withRun(session.resume());
			if (prompt !== undefined && prompt !== "") {
				await withRun(session.run(prompt));
			}
		}
	} finally {
		rl.close();
	}
}

async function main(): Promise<void> {
	const [command, arg] = process.argv.slice(2);
	// 八: faux mode is the keyless demo script — an exhausted script must
	// exit non-zero, never masquerade as a successful provider run.
	const faux = process.env.ANTHROPIC_API_KEY === undefined && process.env.OPENAI_API_KEY === undefined;
	let agent: Awaited<ReturnType<typeof makeAgent>> | undefined;

	try {
		switch (command) {
			case "chat": {
				const id = arg ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				// v2b: the dock (TTY only) wraps the whole session — the
				// trust question, the banner, the body, and the input line.
				dock.enter();
				// E 区: a resumed session continues the script at its durable
				// position — never restarts it (fauxSkip).
				const agent = await makeAgent(fauxSkip(id));
				const session = await agent.session({ id });
				bodyLog(`session ${id}\n`);
				extensionsBanner();
				await chat(session, faux);
				break;
			}
			case "resume": {
				if (!arg) {
					console.error("usage: kiso resume <sessionId> [\"prompt\"]");
					process.exit(2);
				}
				// argv[4] is the optional prompt; argv[3] is the session id
				// (argv = [node, script, resume, id, prompt?]).
				const prompt = process.argv[4];
				dock.enter();
				const agent = await makeAgent(fauxSkip(arg));
				const session = await agent.session({ id: arg });
				await resume(session, prompt, faux);
				break;
			}
			case "sessions": {
				const agent = await makeAgent();
				for (const meta of agent.sessions()) {
					console.log(renderSessionLine(meta));
				}
				break;
			}
			case "help": {
				const p = palette();
				console.log(
					`${p.dim}${LOGO_TOP}${p.blue}${TAGLINE}${p.reset}${p.dim}${LOGO_BOTTOM}${p.reset}\n\n` +
						"kiso — the coding agent that survives kill -9\n\n" +
						"  kiso [sessionId]         interactive session (default command)\n" +
						"  kiso chat [sessionId]    same as above\n" +
						"  kiso resume <id> [prompt]   continue a session (one-shot)\n" +
						"  kiso sessions           list durable sessions\n" +
						"  kiso help               this help\n",
				);
				break;
			}
			case undefined:
			default: {
				// A 区: no subcommand (or any non-command first argument) IS
				// chat — the first argument is the session id.
				const id = command ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				dock.enter();
				const agent = await makeAgent(fauxSkip(id));
				const session = await agent.session({ id });
				bodyLog(`session ${id}\n`);
				extensionsBanner();
				await chat(session, faux);
				break;
			}
		}
	} finally {
		// E 组: every normal and abnormal exit releases the fds and writer
		// locks — no lock file is left behind.
		agent?.close();
		// v2b: the dock tears down on EVERY exit path — CSI r resets the
		// scroll region, the cursor lands at the input line, no broken
		// terminal (kill -9 excepted; `reset` saves it).
		dock.exit();
		// 发现#8 (P1): extension dispose runs on the same exit path — a
		// dispose failure prints one line and NEVER changes the exit code.
		await disposeExtensions(loadedExtensions);
		// E3: the merged mcp/skills temp artifacts are best-effort removed on
		// the same exit path — a cleanup failure is silent (tmpdir reaps).
		for (const p of mergedTempPaths) {
			try {
				rmSync(p, { recursive: true, force: true });
			} catch {
				// best-effort — the temp dir would be reaped by the OS
			}
		}
	}
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		// 十: top-level errors are terminal-escaped. v2a: the exit is EXPLICIT
		// — natural drain is racy on a TTY (readline leaves the stdio handles
		// active and the loop sometimes never drains). main's finally already
		// ran (agent.close, dispose, temp cleanup) — nothing is skipped, no
		// lock is left behind; the exit code is honest.
		console.error(escapeTerminal(err instanceof Error ? err.message : String(err)));
		process.exit(1);
	});
