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
import { Body } from "@vincemakes/kiso-tui";
import { editFileDiff, writeFileDiff, type DiffResult } from "@vincemakes/kiso-tui";
import { MODES, getMode, modeExtensions, modeFromEnv, modeSystemPrompt, setMode, type Mode } from "./mode.js";
import { Editor, PROMPT as EDITOR_PROMPT } from "@vincemakes/kiso-tui";
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
import { canonicalTargetPath, createCodingTools } from "@vincemakes/kiso-tools-node";
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
	bannerLines,
	kUnit,
	renderRecap,
	truncateRow,
} from "@vincemakes/kiso-tui";
import { Dock } from "@vincemakes/kiso-tui";



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
function startupBanner(): string {
	// v3 §01: the banner is block-split — three independent logo rows
	// (TOP / tagline / BOTTOM), then TWO info rows (version,
	// extensions), each truncated at the window width; < 40 columns
	// skips the logo. The historical `[N extensions: names]` text rides
	// the extensions row verbatim (the e2e assertions keep matching).
	const p = palette();
	// A pty without a winsize reports columns = 0 (not undefined) — treat
	// it as the default width, never as a 0-column truncation.
	const W = process.stdout.columns ?? 0;
	const rows = bannerLines(W > 0 ? W : 80, VERSION, bannerExtensionText().replace(/^ · /, ""));
	return `${rows.map((r) => `${p.dim}${r}${p.reset}`).join("\n")}\n`;
}

/** v2a: the interactive prompt — blue, the identity accent. readline owns
 *  the echo of what the user types; we own the prompt's color. (v2c: the
 *  readline prompt keeps "you> " — the brick ▌ is the dock's row only;
 *  pipe bytes must not change.) */
function interactivePrompt(): string {
	const p = palette();
	return `${p.blue}you> ${p.reset}`;
}

/**
 * v2c — the interactive input source. TTYs use the raw-mode Editor (the
 * self-drawn input row — width-aware, the CJK-drift root cause retired,
 * editor.ts); everything else keeps readline exactly as v2b (pipe bytes
 * unchanged). ask()/chat()/resume() talk to this, never to a concrete
 * source.
 */
interface LineInput {
	onLine(cb: (line: string) => void): void;
	onSigint(cb: () => void): void;
	onEot(cb: () => void): void;
	onEscape(cb: () => void): void;
	question(query: string, cb: (answer: string) => void): void;
	cancelQuestion(): void;
	emitLine(line: string): void;
	line(): string;
	clearLine(): void;
	prompt(): void;
	close(): void;
	readonly closed: Promise<void>;
}

/** The v2b behavior, unchanged: readline owns the line, SIGINT, and the
 *  prompt. Only ever constructed when stdin is NOT a TTY. The rl starts
 *  consuming stdin at construction (main), so 'line' events are buffered
 *  until chat() wires the handler — pipe input must never be dropped. */
function readlineInput(rl: ReturnType<typeof createInterface>): LineInput {
	let lineCb: ((line: string) => void) | null = null;
	const pending: string[] = [];
	rl.on("line", (line) => {
		if (lineCb === null) pending.push(line);
		else lineCb(line);
	});
	return {
		onLine(cb) {
			lineCb = cb;
			for (const line of pending) cb(line);
			pending.length = 0;
		},
		onSigint(cb) {
			rl.on("SIGINT", cb);
		},
		onEot() {
			/* readline's Ctrl+D on an empty line is EOF → 'close' — the
			 * exit path is the close, nothing to wire here. */
		},
		onEscape() {
			/* readline has no bare-Esc semantics — ignored. */
		},
		question(query, cb) {
			rl.question(query, cb);
		},
		cancelQuestion() {
			/* the rl.question stays pending; the settled branch re-emits
			 * the answer as a new line. */
		},
		emitLine(line) {
			rl.emit("line", line);
		},
		line() {
			return rl.line;
		},
		clearLine() {
			/* readline: Ctrl+C is exit/abort only — nothing to clear. */
		},
		prompt() {
			rl.setPrompt(interactivePrompt());
			rl.prompt();
		},
		close() {
			rl.close();
		},
		closed: new Promise((resolve) => rl.on("close", () => resolve())),
	};
}

/** The v2c TTY path: the editor's events map 1:1 onto the interface; the
 *  input row renders on every state change (the CLI's onRender wiring). */
function editorInput(editor: Editor): LineInput {
	return {
		onLine(cb) {
			editor.onLine(cb);
		},
		onSigint(cb) {
			editor.onSigint(cb);
		},
		onEot(cb) {
			editor.onEot(cb);
		},
		onEscape(cb) {
			editor.onEscape(cb);
		},
		question(query, cb) {
			editor.question(query, cb);
		},
		cancelQuestion() {
			editor.cancelQuestion();
		},
		emitLine() {
			/* the editor's buffer survives a cancelled question — its text
			 * becomes the next turn on Enter (the readline re-emit
			 * equivalent). */
		},
		line() {
			return editor.line();
		},
		clearLine() {
			editor.clearLine();
		},
		prompt() {
			/* the editor renders on every state change — nothing to arm. */
		},
		close() {
			editor.exit();
		},
		closed: editor.closed,
	};
}

/** One input source per process: the raw-mode Editor on a TTY (entered
 *  here, bound to the dock once — the trust question, chat, and resume
 *  all read through it), readline elsewhere. */
function makeLineInput(): LineInput {
	if (process.stdin.isTTY) {
		const editor = new Editor(() => (dock.active ? dock.redraw() : editor.selfRender()));
		editor.enter();
		const p = palette();
		dock.bindInput(() => editor.dockState(), `${p.blue}${EDITOR_PROMPT}${p.reset}`);
		dock.bindMenu(() => editor.menuState()); // v3 §04: the slash-command menu
		return editorInput(editor);
	}
	return readlineInput(createInterface({ input: process.stdin, output: process.stdout }));
}

/** v2b: the bottom-anchored UI — docked only on a color TTY; pipes and
 *  NO_COLOR stay the v2a line mode byte-for-byte. */
const dock = new Dock();

/** v2d: the body renderer — the ONE writer of the stdout scroll region
 *  (the frozen area + the active tail). Pipes run it in passthrough (the
 *  v2b/v2c line-mode bytes, byte-for-byte). Created in main; closed on
 *  every exit path. */
let body: Body;

/** v2d: body output routes through the cell renderer — the single writer.
 *  bodyLog adds the trailing newline; internal newlines are preserved. */
function bodyLog(text: string): void {
	body.raw(text.split("\n"));
}

/** v2b: the spinner merged into the STATUS BAR (the v2a standalone glyph
 *  is gone) — docked only, 200ms rotation between the request and the
 *  first event. */
function startStatusSpinner(onTick: (glyph: string) => void): () => void {
	if (!dock.active) return () => {};
	// v3 §03/§05: the working glyph family ▖▘▝▗, 200ms rotation — the
	// callback repaints the running status line with the new glyph.
	const GLYPHS = ["▖", "▘", "▝", "▗"];
	let i = 0;
	const timer = setInterval(() => onTick(GLYPHS[i++ % GLYPHS.length]!), 200);
	timer.unref();
	return () => clearInterval(timer);
}

/** v3 §03: "running <tool> Ns" is gone — the running status line owns
 *  the wall clock; the per-tool timer was the old tail mechanism. */

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
async function resolveProjectTrust(input: LineInput): Promise<ProjectArtifacts | null> {
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
	// v2c: the shared input (the editor on a TTY) reads the answer; the
	// dock shows the question at the status position.
	bodyLog(`[project .kiso] ${artifacts.root}`);
	for (const f of artifacts.files) {
		bodyLog(`  ${f.path}  (${f.digest.slice(0, 6)})`);
	}
	const answer = await ask(input, `trust this project's .kiso? (y/n) `);
	const granted = answer !== CANCELLED && answer.trim().toLowerCase().startsWith("y");
	recordTrust({ root: artifacts.root, digest: artifacts.digest, decision: granted ? "granted" : "refused" });
	if (!granted) return null;
	applyProjectMerges(artifacts);
	return artifacts;
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

async function makeAgent(fauxSkipTurns = 0, input?: LineInput) {
	const store = new SessionStore(sessionsDir());

	// E3: the project-level trust gate runs BEFORE any extension load (the
	// mcp/skills merges must be in the env when the user-level extensions
	// load). Untrusted project capability is never loaded — never silently.
	const project = input !== undefined ? await resolveProjectTrust(input) : await resolveProjectTrust(undefined as unknown as LineInput);
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
		// Modes: the five tiers ride the E1 policy chain (mode:<tier>
		// extensions, current tier first) — the old static PERMISSION_POLICY
		// is gone, its semantics live in the "default" tier. The banner
		// still counts loadedExtensions only — the modes are in-process,
		// never a file extension.
		systemPrompt: (() => {
			const sp = composeSystemPrompt(process.cwd());
			const extra = modeSystemPrompt();
			return extra === undefined ? sp : `${sp}\n\n${extra}`;
		})(),
		// C 区: microcompact is ON by default in the product — threshold =
		// half the model window (KISO_CONTEXT_WINDOW override included;
		// 200k window → 100k tokens). Long sessions compact old read/list/
		// search/shell outputs instead of silently growing past the window.
		microcompact: { thresholdTokens: contextWindowTokens() / 2 },
		maxTurns: 20,
		// Modes: the five tiers join at the CHAIN HEAD, before the user/
		// project extensions (the deny>ask>allow composition keeps a user
		// deny winning over any mode tier — bypass included).
		extensions: [...modeExtensions(), ...loadedExtensions],
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
function ask(input: LineInput, question: string): Promise<string | typeof CANCELLED> {
	if (!process.stdin.isTTY) {
		console.log(`[non-interactive — no human to ask: ${question}]`);
		return Promise.resolve("");
	}
	// v2b: docked — the question takes over the status position, the
	// answer lands at the input line. v2c: a TTY without a dock (rows < 4)
	// prints the question into the body — the editor cannot show it.
	if (dock.active) {
		dock.showQuestion(question);
	} else {
		bodyLog(question);
	}
	return new Promise((resolve) => {
		let settled = false;
		pendingAsk = () => {
			if (settled) return;
			settled = true;
			pendingAsk = null;
			input.cancelQuestion();
			resolve(CANCELLED); // the run is aborting — the question is dead
		};
		// v2b: docked — the question reads at the input line, whose prompt
		// is the same blue you> (the editor's brick row; the readline path
		// passes the plain question). An empty prompt would start readline
		// at column 1 while the dock renders "you> " — the typed answer
		// would land on the prompt and drift (probe-confirmed).
		input.question(dock.active ? interactivePrompt() : question, (answer) => {
			if (settled) {
				// The question was cancelled; this line is a NEW user turn.
				input.emitLine(answer);
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
	input: LineInput,
	isCancelled: () => boolean,
): Promise<void> {
	for (const uncertain of session.uncertainExecutions()) {
		const answer = await ask(
			input,
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
/** v2e: the approval-moment mini-diff — edit_file/write_file changes as
 *  ± lines; other tools get null (no diff, no cost). The file read is
 *  best-effort: an unreadable file yields NO diff, never a failure —
 *  the diff must never break the approval. */
function approvalDiff(name: string, input: Record<string, unknown>): DiffResult | null {
	if (name !== "edit_file" && name !== "write_file") return null;
	const path = typeof input.path === "string" ? input.path : "";
	if (path === "") return null;
	let oldContent: string | null = null;
	try {
		oldContent = readFileSync(path, "utf8");
	} catch {
		// a new write_file target (or an unreadable one) — all + degrades
	}
	try {
		if (name === "edit_file") {
			const search = typeof input.search === "string" ? input.search : "";
			const replace = typeof input.replace === "string" ? input.replace : "";
			if (search === "") return null;
			return editFileDiff(oldContent ?? "", search, replace);
		}
		const content = typeof input.content === "string" ? input.content : "";
		return writeFileDiff(oldContent, content);
	} catch {
		return null; // never let the diff break the approval
	}
}

async function consumeRun(
	session: AgentSession,
	run: AsyncIterable<import("@vincemakes/kiso-core").Event>,
	input: LineInput,
	turnNo: number,
	faux: boolean,
	liveInput: { current: string | null } | null,
	statusCb: ((usage: RunUsage, ctxRatio: number) => void) | null,
): Promise<import("@vincemakes/kiso-core").Event | undefined> {
	let last: import("@vincemakes/kiso-core").Event | undefined;
	let usage: RunUsage = { in: null, out: null, cache: null, known: false };
	// v3 §02: the recap line derives ENTIRELY from the local event stream
	// (zero tokens) — wall seconds, tool/edit counts, usage, ctx left.
	const turnStart = Date.now();
	let toolCount = 0;
	let editCount = 0;
	try {
	for await (const ev of run) {
		last = ev;
		// v2a (双回显): the interactive echo was already rendered by the
		// input source — rendering the event again is the double echo.
		// v2b: DOCKED — the echo lives in the input row (H), NOT the body;
		// the body render is the ONLY visible copy of the sent line.
		if (
			ev.type === "user_input" &&
			liveInput !== null &&
			liveInput.current === (typeof ev.content === "string" ? ev.content : "") &&
			process.stdin.isTTY &&
			!dock.active
		) {
			continue;
		}
		// v2d: EVERY event only mutates a cell — the Body is the single
		// writer of the scroll region, so interleaving is impossible by
		// construction (ADR-0040).
		switch (ev.type) {
			case "user_input":
				body.userLine(typeof ev.content === "string" ? ev.content : "");
				break;
			case "thinking":
				body.thinkingAppend(ev.text);
				break;
			case "tool_call_end":
				toolCount += 1;
				if (ev.name === "edit_file") editCount += 1;
				body.toolStart(ev.name, ev.callId, ev.input ?? {});
				break;
			case "tool_execution_started":
				body.toolRunning(ev.callId);
				break;
			case "tool_execution_succeeded":
				body.toolSucceeded(ev.callId);
				break;
			case "tool_execution_failed":
				body.toolFailed(ev.callId, ev.error);
				break;
			case "tool_result": {
				const text = typeof ev.content === "string" ? ev.content : "";
				body.toolResult(ev.callId, { content: text, isError: ev.isError });
				break;
			}
			case "text_delta":
				body.textAppend(ev.text);
				break;
			case "text_end":
				body.textEnd();
				break;
			case "usage":
				usage = { in: ev.inputTokens, out: ev.outputTokens, cache: ev.cacheRead, known: ev.known };
				statusCb?.(usage, estimateCtxRatio(session));
				break;
			case "uncertain_pending":
				// 裁决 #12 (ADR-0038): the ⚠ line is pure INFORMATION now — the
				// approval chain guards retries, and the human question belongs
				// only to the crash window's recovery flow (resolveUncertains).
				body.notice(`⚠ ${escapeTerminal(ev.name)} FAILED — the side effect may have applied. ${escapeTerminal(ev.error)}`);
				break;
			case "permission_requested": {
				// v2d: the ToolCell shows the ⏸ badge; the question takes over
				// the dock status position; the answer lands at the input line.
				// v2e: the mini-diff for edit/write at the approval moment —
				// the human sees the change BEFORE deciding (auto-allowed tools
				// skip the diff: nobody is looking).
				const name = (ev as { name: string }).name;
				body.toolApproval(ev.callId, approvalDiff(name, ev.input ?? {}));
				const decisionId = (ev as { decisionId: string }).decisionId;
				const answer = await ask(input, `approve ${escapeTerminal(name)}? (y/n) `);
				if (answer === CANCELLED) {
					// 十: a cancellation is a CONSERVATIVE denial, explicitly
					// distinguished from the user typing "n".
					body.notice("[approval cancelled — treated as a denial]");
					await session.approve(decisionId, false);
					continue;
				}
				await session.approve(decisionId, answer.trim().toLowerCase().startsWith("y"));
				break;
			}
			case "terminal": {
				// v3 §02: the run's recap line REPLACES the old "done" label
				// + status line — one local line, derived from this run's
				// events (zero tokens). The dock's status bar still paints.
				statusCb?.(usage, estimateCtxRatio(session));
				const ratio = estimateCtxRatio(session);
				bodyLog(
					renderRecap({
						seconds: Math.round((Date.now() - turnStart) / 1000),
						tools: toolCount,
						edits: editCount,
						usage,
						ctxLeftPct: Number.isFinite(ratio) ? (1 - ratio) * 100 : null,
					}),
				);
				break;
			}
			default: {
				// Events without a cell (stop, …) — the generic render, byte-
				// preserved for the pipe path.
				const rendered = renderEvent(ev, false, canonicalTargetPath);
				if (rendered.text !== "") {
					body.raw(rendered.text.replace(/\n$/, "").split("\n"));
				}
				break;
			}
		}
	}
	body.thinkingEnd(); // a trailing thinking block folds at the run's end
	} finally {
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
	input: LineInput | undefined,
): void {
	if (!faux) return;
	if (last?.type !== "terminal" || last.outcome.kind !== "error") return;
	const message = last.outcome.error.message;
	input?.close(); // the REPL must not stay open waiting for a line
	throw new FauxExhaustionError(
		message.startsWith("provider stream ended without a stop event")
			? "[faux mode] the scripted demo turns are exhausted — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model"
			: `[faux mode] the scripted model failed: ${escapeTerminal(message.slice(0, 200))}`,
	);
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
async function chat(session: AgentSession, faux: boolean, input: LineInput): Promise<void> {
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;

	const turn = (text: string): Promise<void> =>
		new Promise((resolve, reject) => {
			queued = Math.max(0, queued - 1); // a queued turn starts
			// v2a: the echo filter compares the user_input event against THIS
			// turn's own input — lines that arrive ahead of their turn (piped
			// bursts, queued replays) must not overwrite the reference.
			liveInput.current = text;
			const run = session.run(text);
			currentRun = run;
			turnNo += 1;
			const myTurn = turnNo;
			// v3 §03: the running state owns the status bar — the glyph
			// rotates every 200ms; the idle state returns after the run.
			runStart = Date.now();
			runUsage = { in: null, out: null, cache: null, known: false };
			const stopSpinner = startStatusSpinner((g) => {
				runGlyph = g;
				paintRunning();
			});
			(async () => {
				let last: import("@vincemakes/kiso-core").Event | undefined;
				try {
					last = await consumeRun(session, run, input, myTurn, faux, liveInput, statusCb);
					stopSpinner();
					paintIdle();
					currentRun = null;
					// 八: a faux script that ran out of declared turns exits
					// loudly with a non-zero status — never a silent status 0.
					// 第四轮(对抗): the exhaustion is a CONTROLLED rejection of
					// this turn's promise — it propagates through the chain to
					// chat to main's finally/catch, never an orphaned
					// unhandled rejection from the IIFE.
					failOnFauxExhaustion(last, faux, input);
					// 八: after EVERY turn the prompt is re-armed — the human
					// never types blind after the first turn.
					input.prompt();
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
					input.prompt();
					resolve();
				}
			})();
		});

	input.onSigint(() => {
		if (currentRun) {
			// 八: Ctrl+C cancels BOTH the pending question (if one is
			// awaiting a line) and the run — the run then writes its unique
			// aborted terminal, which the consumer keeps consuming.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (pendingAsk !== null) {
			pendingAsk?.(); // a startup/trust question — cancel it
		} else if (input.line() === "") {
			cancelled = true;
			console.log("\n[exit requested]");
			input.close();
		} else {
			input.clearLine(); // v2c: Ctrl+C on a non-empty line clears it
		}
	});
	input.onEot(() => {
		if (!currentRun && pendingAsk === null && input.line() === "") {
			cancelled = true;
			console.log("\n[exit requested]");
			input.close();
		}
	});
	input.onEscape(() => {
		if (currentRun) {
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
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
	// B 区: user-turn counter for the status line. /last and /think read
	// the body (the ToolCell / ThinkingCell final states).
	let turnNo = 0;
	// v2a: the last line THIS process's readline consumed — the double-echo
	// filter (see consumeRun). Only interactive chat sets it.
	const liveInput: { current: string | null } = { current: null };
	// v2c: turns submitted while another runs are QUEUED on the chain — the
	// live count rides the status bar (+N queued).
	let queued = 0;
	// v2b: the live status bar (docked only). Modes: /mode switches repaint
	// it immediately through paintStatus (the last turn stats are kept).
	// v3 §03: the status bar has TWO states. Idle: the mode is ALWAYS
	// shown (default included) with the /mode hint. Running: the working
	// glyph (▖▘▝▗ — the spinner drives it) + wall seconds + ↓ out tokens
	// + the interrupt hint. ctx left is the live estimate everywhere.
	let runUsage: RunUsage = { in: null, out: null, cache: null, known: false };
	let runGlyph = "▖";
	let runStart = Date.now();
	const paintRunning = (): void => {
		if (!dock.active) return;
		const ratio = estimateCtxRatio(session);
		const pct = Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
		const out = runUsage.out !== null ? ` ↓ ${kUnit(runUsage.out)} tokens` : "";
		dock.setStatus(
			`${runGlyph} working ${Math.max(1, Math.round((Date.now() - runStart) / 1000))}s${out} · esc to interrupt · ctx left ~${pct}%`,
		);
	};
	const paintIdle = (): void => {
		if (!dock.active) return;
		const ratio = estimateCtxRatio(session);
		const pct = Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
		dock.setStatus(`▸ ${getMode()} · /mode to switch · ${agentModel} · ctx left ~${pct}%`);
	};
	const statusCb = (u: RunUsage, ctx: number): void => {
		runUsage = u;
		paintRunning();
	};
	// The ONE dispatcher: slash commands, exit, and turns. The recovery
	// replay routes through it too — a queued "/last" must never become a
	// user turn (v2c: the rl lives in main, so lines arrive earlier and
	// the queue is the common path).
	const dispatch = (line: string): void => {
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
				bodyLog(cmd("/mode", "show the approval tier; /mode <name> switches (manual/default/accept-edits/plan/bypass)"));
				bodyLog(cmd("/compact", "summarize the older conversation to free context"));
				bodyLog(cmd("exit", "leave the session"));
				input.prompt();
			});
			return;
		}
		if (trimmed === "/think") {
			// v2b/v2d: print the last COMPLETE thinking block — the body holds
			// it (the ThinkingCell's fold closes at the block's end).
			chain = chain.then(async () => {
				const t = body.lastThinking();
				if (t === null) {
					bodyLog("[no thinking yet]");
				} else {
					bodyLog(escapeTerminal(t));
				}
				input.prompt();
			});
			return;
		}
		if (trimmed === "/last") {
			// B 区/v2d: print the FULL input/output of the most recent tool
			// call — the body holds it (the ToolCell's final state). Runs on
			// the chain: after any in-flight turn completes.
			chain = chain.then(async () => {
				const tool = body.lastTool();
				if (tool === null) {
					bodyLog("[no tool call yet]");
				} else {
					bodyLog(`--- ${tool.name} input ---`);
					bodyLog(escapeTerminal(JSON.stringify(tool.input, null, 2)));
					bodyLog(`--- ${tool.name} output${tool.result.isError ? " (error)" : ""} ---`);
					bodyLog(escapeTerminal(tool.result.content));
				}
				input.prompt();
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
				input.prompt();
			});
			return;
		}
		if (trimmed === "/mode" || trimmed.startsWith("/mode ")) {
			// Modes: /mode alone prints the current tier + the list;
			// /mode <name> switches — the notice cell leaves the audit
			// line in the body, the status bar repaints at once.
			chain = chain.then(async () => {
				const m = MODES.find((x) => x === trimmed.slice(5).trim());
				if (trimmed.slice(5).trim() === "") {
					bodyLog(`mode ${getMode()}`);
					bodyLog(`tiers: ${MODES.join(" ")}`);
				} else if (m === undefined) {
					bodyLog(`no such mode: ${trimmed.slice(5).trim()}`);
					bodyLog(`tiers: ${MODES.join(" ")}`);
				} else {
					setMode(m);
					body.notice(`mode → ${m}`);
					paintIdle();
				}
				input.prompt();
			});
			return;
		}
		if (trimmed === "/compact") {
			// /compact (ADR-0044): the older conversation becomes one
			// model summary — an OFF-LOOP call through the session's own
			// adapter, so it must never race a running turn: refused
			// mid-run, with a hint to wait for the turn to end.
			if (currentRun !== null) {
				body.notice("[/compact] a turn is running — wait for it to finish");
				return;
			}
			chain = chain.then(async () => {
				try {
					const result = await session.summarize();
					if (result === null) {
						body.notice("[/compact] nothing to compact — fewer than 5 rounds yet");
					} else {
						body.notice(`[/compact] saved ~${result.savedTokens.toLocaleString("en-US")} tokens`);
					}
				} catch (err) {
					// Honest failure: nothing was persisted, the session
					// is unchanged (ADR-0044 crash semantics).
					body.notice(`[/compact] failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				input.prompt();
			});
			return;
		}
		if (trimmed === "exit" || trimmed === "") {
			input.close();
			return;
		}
		// v2c: a turn submitted while another runs waits on the chain — the
		// live count rides the status bar (+N queued).
		queued += 1;
		chain = chain.then(() => turn(line));
	};
	input.onLine((line) => {
		if (!replReady) {
			queuedLines.push(line);
			return;
		}
		dispatch(line);
	});

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	// 八: the startup resume is bound to currentRun — Ctrl+C during it
	// aborts the recovery, exactly like the interactive turns.
	await resolveUncertains(session, input, () => cancelled);
	if (!cancelled) {
		const recoveryRun = session.resume();
		currentRun = recoveryRun;
		turnNo += 1;
		const last = await consumeRun(session, recoveryRun, input, turnNo, faux, liveInput, statusCb);
		currentRun = null;
		failOnFauxExhaustion(last, faux, input);
	}
	if (cancelled) {
		input.close();
		await input.closed;
		return;
	}
	// The REPL is ready: replay anything that arrived during recovery.
	replReady = true;
	// v2c: dispatch SYNCHRONOUSLY — each call appends its segment to the
	// chain variable; the final `await chain` then covers every replayed
	// turn. A chain.then(() => dispatch()) indirection would capture the
	// chain BEFORE the appends and the replayed turns would never be
	// awaited (the F-group regression).
	for (const line of queuedLines) {
		dispatch(line);
	}
	queuedLines.length = 0;
	input.prompt();
	await input.closed;
	await chain; // never exit while a turn is in flight
}

/**
 * Resume = the RECOVERY flow (Area 2/7): uncertain executions are decided,
 * the interrupted run is continued via session.resume() — never faked with
 * a new prompt. An optional prompt afterwards starts a genuinely new turn.
 * E 组: SIGINT aborts the run being resumed; every exit path closes the
 * session store so no lock is left behind.
 */
async function resume(session: AgentSession, prompt: string | undefined, faux: boolean, input: LineInput): Promise<void> {
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;
	let turnNo = 0;
	// v3 §03: the two-state status bar (see chat — same shapes).
	let runUsage: RunUsage = { in: null, out: null, cache: null, known: false };
	let runGlyph = "▖";
	let runStart = Date.now();
	const statusCb = (u: RunUsage, ctx: number): void => {
		runUsage = u;
		if (!dock.active) return;
		const pct = Number.isFinite(ctx) ? Math.round((1 - ctx) * 100) : null;
		const out = runUsage.out !== null ? ` ↓ ${kUnit(runUsage.out)} tokens` : "";
		dock.setStatus(
			`${runGlyph} working ${Math.max(1, Math.round((Date.now() - runStart) / 1000))}s${out} · esc to interrupt · ctx left ~${pct}%`,
		);
	};
	const paintIdle = (): void => {
		if (!dock.active) return;
		const ratio = estimateCtxRatio(session);
		const pct = Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
		dock.setStatus(`▸ ${getMode()} · /mode to switch · ${agentModel} · ctx left ~${pct}%`);
	};
	const withRun = async (run: ReturnType<AgentSession["resume"]>): Promise<void> => {
		currentRun = run;
		runStart = Date.now();
		runUsage = { in: null, out: null, cache: null, known: false };
		const stopSpinner = startStatusSpinner((g) => {
			runGlyph = g;
			statusCb(runUsage, estimateCtxRatio(session));
		});
		try {
			turnNo += 1;
			const last = await consumeRun(session, run, input, turnNo, faux, null, statusCb);
			failOnFauxExhaustion(last, faux, input);
		} finally {
			stopSpinner();
			paintIdle();
			currentRun = null;
		}
	};
	input.onSigint(() => {
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
			input.close();
		}
	});
	input.onEot(() => {
		if (!currentRun && !cancelled && input.line() === "") {
			cancelled = true;
			console.log("\n[exit requested]");
			input.close();
		}
	});
	input.onEscape(() => {
		if (currentRun) {
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		}
	});
	try {
		await resolveUncertains(session, input, () => cancelled);
		if (!cancelled) {
			await withRun(session.resume());
			if (prompt !== undefined && prompt !== "") {
				await withRun(session.run(prompt));
			}
		}
	} finally {
		input.close();
	}
}

async function main(): Promise<void> {
	// Modes: --mode <name> wins over KISO_MODE — both applied before the
	// first makeAgent (the tier extensions read `current` live). The flag
	// is stripped from the positional args, so it works in any position.
	const args = process.argv.slice(2);
	const modeFlag = args.indexOf("--mode");
	if (modeFlag !== -1) {
		const m = MODES.find((x) => x === args[modeFlag + 1]);
		if (m === undefined) {
			console.error(`unknown mode: ${args[modeFlag + 1]} (tiers: ${MODES.join(", ")})`);
			process.exit(2);
		}
		setMode(m);
		args.splice(modeFlag, 2);
	} else {
		setMode(modeFromEnv());
	}
	const [command, arg] = args;
	// 八: faux mode is the keyless demo script — an exhausted script must
	// exit non-zero, never masquerade as a successful provider run.
	const faux = process.env.ANTHROPIC_API_KEY === undefined && process.env.OPENAI_API_KEY === undefined;
	let agent: Awaited<ReturnType<typeof makeAgent>> | undefined;

	// v2c: ONE input source per process — the raw-mode editor on a TTY
	// (entered here, dock-bound, trusted before any extension loads),
	// readline elsewhere. The trust question, chat, and resume all read
	// through it; main's finally closes it on every exit path.
	const input = makeLineInput();
	// v2d: the body renderer — active only where the dock is (a color
	// TTY with a real size); pipes run it in passthrough, byte-for-byte.
	body = new Body({
		active: () => process.stdin.isTTY && palette().blue !== "" && (process.stdout.rows ?? 0) >= 4,
		height: () => process.stdout.rows ?? 24,
		width: () => process.stdout.columns ?? 80,
		editCol: () => dock.editCol(),
		onDock: () => dock.redraw(), // v2d-B: the freeze scrolls the dock up — re-pin it
	});
	try {
		switch (command) {
			case "chat": {
				const id = arg ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				// v2b: the dock (TTY only) wraps the whole session — the
				// trust question, the banner, the body, and the input line.
				dock.enter();
				// E 区: a resumed session continues the script at its durable
				// position — never restarts it (fauxSkip).
				const agent = await makeAgent(fauxSkip(id), input);
				const session = await agent.session({ id });
				bodyLog(`session ${id}\n`);
				extensionsBanner();
				await chat(session, faux, input);
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
				const agent = await makeAgent(fauxSkip(arg), input);
				const session = await agent.session({ id: arg });
				await resume(session, prompt, faux, input);
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
					`${p.dim}${bannerLines(80, VERSION, "").join("\n")}${p.reset}\n\n` +
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
				await chat(session, faux, input);
				break;
			}
		}
	} finally {
		body.close(); // flush the pending frame, stop the heartbeat
		input.close();
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
