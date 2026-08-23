#!/usr/bin/env node
/**
 * kiso — the coding-agent reference product.
 *
 *   kiso chat [sessionId]   start or continue an interactive session
 *   kiso resume <sessionId> continue a session in one-shot mode
 *   kiso sessions           list durable sessions
 *
 * Provider selection (first match — PH-1b corrected this header: the
 * code has always checked OPENAI first, config.ts resolveModel):
 *   OPENAI_API_KEY         → OpenAI-compatible (OPENAI_MODEL default gpt-4o, OPENAI_BASE_URL)
 *   ANTHROPIC_API_KEY      → Anthropic (ANTHROPIC_MODEL, default claude-sonnet-5)
 *   neither                → faux mode: scripted model, zero keys, full CLI
 *
 * Sessions live under $KISO_HOME/sessions (default ~/.kiso/sessions) as
 * append-only JSONL. Write/edit/shell tools sit behind the approval policy:
 * the run pauses, asks, and resumes — durably (ADR-0024).
 *
 * The ergonomics batch B4 (pure move): the interactive pieces live beside this file —
 * chat.ts (the REPL + consumeRun), dispatch.ts (the slash dispatcher),
 * resume.ts, trust-ui.ts (the question surface + E3 merges), faux-glue.ts
 * (the scripted-model plumbing), state.ts (the shared process state).
 * index.ts keeps the entry: banner, input sources, the A area prompt,
 * makeAgent, and main.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { BADGE_GLYPH, Body, Editor, bannerLines, escapeTerminal, extensionsBannerText, idColumn, idleStatus, interactivePrompt, palette, renderSessionLine, sessionListFooter, sessionListRow, type ResumeMeta, type SessionCardView } from "@vincemakes/kiso-tui";
import {
	createAgent,
	disposeExtensions,
	loadExtensions,
	loadProjectExtensions,
	SessionStore,
	type AgentDefinition,
	type ContextPolicy,
} from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { MODES, getMode, modeExtensions, modeFromEnv, modeSystemPrompt, setMode } from "./mode.js";
import { builtInLayer } from "./builtin.js";
import { agentModel, atFiles, body, bodyLog, kisoHome, builtInExtensions, currentFaux, dock, extensionsDir, loadedExtensions, mergedConfig, mergedTempPaths, projectExtensions, sessionStoreRef, sessionsDir, setAgentModel, setBody, setConfigModels, setConfiguredWindow, setCurrentAgentExtensions, setCurrentFaux, setCurrentModelName, setExtensionLists, setMergedConfig, setSessionStore, userExtensions, VERSION, type LineInput } from "./state.js";
import { askUi, resolveProjectTrust } from "./trust-ui.js";
import { isFirstRun, scaffoldFirstRun } from "./first-run.js";
import { fauxSkip, readFauxScript } from "./faux-glue.js";
import { autoCompactFromEnv, chat, contextWindowTokens, estimateCtxRatio } from "./chat.js";
import { loadProjectConfig, loadUserConfig, mergeConfigs, resolveAutoCompact, resolveContextWindow, resolveModel } from "./config.js";
import { resume } from "./resume.js";
import { collectSessionCards, projectSessionCard } from "./session-cards.js";

// The moved exports stay reachable from this entry — the test imports
// (project-trust, coding-agent) never change (B4: zero assertion changes).
export { applyProjectMerges } from "./trust-ui.js";

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
		onExpand() {
			/* readline has no ctrl+r binding — ignored (W15 rides the
			 * editor path only). */
		},
		question(query, cb) {
			rl.question(query, cb);
		},
		cancelQuestion() {
			/* the rl.question stays pending; the settled branch re-emits
			 * the answer as a new line. */
		},
		// W21: readline is never asked — askPanel's non-TTY branch
		// auto-denies before any panel opens (the pipe path).
		panelAsk() {
			/* unreachable — non-TTY asks auto-deny in askPanel */
		},
		panelCancel() {
			/* unreachable */
		},
		// W22: readline has no ↑/esc pop — the pipe path shows no chips
		// and pops nothing (the queue drains on its own).
		bindQueue() {
			/* unreachable — no raw keys in the pipe path */
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

/* PH-1a (findings PH-F6/PH-F10, the exit-wedge dossier — recorded, NOT
 * fixed here): node keeps TTY fds in blocking mode, macOS pty output
 * buffers are ~1KB, and on an UNREAD terminal a departing process can
 * wedge two ways: (a) process.exit's own flush of pending blocking-TTY
 * writes, and (b) the editor teardown's uv_tty_set_mode → tcsetattr
 * (TCSADRAIN), which waits for that same drain inside an ioctl. Both are
 * pre-existing and both are masked by the DEFAULT SIGTERM/SIGHUP
 * disposition (kernel-level death cuts through a parked loop). Two
 * repairs were built and REVERTED on evidence this round: a JS signal
 * handler (a caught signal needs the loop the wedge just parked — see
 * the tcsetattr ruling at main's handler comment) and a
 * setBlocking(false)-at-exit rule (a non-blocking TTY plus an immediate
 * process.exit DROPS the queued tail — the banner's version line and the
 * dock's CSI r vanished; node made TTYs blocking precisely to prevent
 * that truncation, and that choice is load-bearing). A real fix needs a
 * non-draining native restore path — the PH-F6 mini-spec. */

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
			// E group (the graceful-exit gate ③): a closed pty master is an
			// EOF, not a \x04 byte — the editor's raw key loop never sees it.
			// The stream's 'end' fires the same EOT callback; the chat/resume
			// exit condition (no run, no panel, empty line) decides, so the
			// exit sequence — and with it the lock release — runs.
			process.stdin.on("end", () => cb());
		},
		onEscape(cb) {
			editor.onEscape(cb);
		},
		onExpand(cb) {
			editor.onExpand(cb);
		},
		// KC2 §2: the redirect gesture — the editor decides WHEN (the
		// same-chunk pair, the precedence gate); chat decides what it MEANS.
		onRedirect(cb) {
			editor.onRedirect(cb);
		},
		question(query, cb) {
			editor.question(query, cb);
		},
		cancelQuestion() {
			editor.cancelQuestion();
		},
		// W21: the panel — the editor's own state machine takes the
		// keys; the compositor renders it via the bound state.
		panelAsk(view, onCommit, opts) {
			editor.beginPanel(view, onCommit, opts);
		},
		panelCancel() {
			editor.cancelPanel();
		},
		// TUI2-R2 ②: the session picker — the editor owns the keys (the
		// selection walk, the filter, enter/esc), the compositor draws the
		// band, and the id comes back here.
		pick(cards, onPick) {
			editor.beginPick(cards, onPick);
		},
		// W22: the pending-turn queue — the ↑ pop walk (the keys); the
		// chips are the compositor's bindQueue (the dock side).
		bindQueue(state, pop) {
			editor.bindQueue(state, pop);
		},
		// R3a: cross-session history — the CLI owns the file I/O.
		bindHistory(seed, persist) {
			editor.bindHistory(seed, persist);
		},
		onModeCycle(cb) {
			editor.onModeCycle(cb);
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
		// W6: the box's prompt goes light — "› " (the box already says
		// "input lives here"; the line-mode path keeps the brick ▌, so
		// pipe bytes do not change)
		dock.bindInput(() => editor.dockState(), "› ");
		// TUI2-R3v2 ②: the click hit-test's wiring — the compositor places
		// the panel's option rows, so the compositor is what the editor asks
		// where they are. Neither side computes the other's geometry.
		editor.bindPanelRows(() => dock.panelOptionRows());
		dock.bindMenu(() => editor.menuState()); // v3 §04: the slash-command menu
		editor.bindAtItems(atFiles); // KC3 §5: the file source — listed per OPEN
		dock.bindAt(() => editor.atState()); // KC3 §4: the picker's band
		dock.bindApproval(() => editor.panelState()); // W21: the panel's bound state
		dock.bindSheet(() => editor.sheetOpen()); // TUI2-R1 (D): the ? keys sheet
		dock.bindPick(() => editor.pickState()); // TUI2-R2 ②: the resume picker's band
		return editorInput(editor);
	}
	return readlineInput(createInterface({ input: process.stdin, output: process.stdout }));
}

/** R-D 0.1.45: the `[N extensions: ...]` text — the built-in column, then
 *  the user-level names, then the project-level ones marked `project:`.
 *  The built-in column is the banner's truthful face of the built-in layer:
 *  a fresh install reads `[3 extensions: built-in: mcp, skills, subagent]`
 *  with zero disk setup (E5: the task extension is opt-in). */
function bannerExtensionText(): string {
	// KC3.5 slice ⓪ (the extraction): the composition moved to the
	// terminal layer (extensionsBannerText — a pure function of the three
	// name lists, including the "(connecting…)" in-flight label). Which
	// lists exist is the CLI's fact and stays here.
	return extensionsBannerText(builtInExtensions, userExtensions, projectExtensions);
}

/** E1: the startup banner line(s) — TTY: logo + merged extensions + the
 *  W5 resume list as a LIVE banner cell (W1: the tier re-derives on
 *  resize; the resume list re-gates with the tier); off-TTY: the
 *  historical `[N extensions: ...]` standalone line (zero change). */
function extensionsBanner(resume: ResumeMeta[] = []): void {
	const text = bannerExtensionText();
	if (!process.stdout.isTTY) {
		if (text !== "") bodyLog(`${text}\n`);
		return;
	}
	body.banner(VERSION, text.replace(/^ · /, ""), resume);
}

/** W5: the opening-screen resume list — up to 3 recent sessions, newest
 *  first, the CURRENT session excluded (it is not something to pick back
 *  up). Every field already exists behind the store's SessionMeta (the
 *  `kiso sessions` line shows the same data) — only the projection and
 *  the sort live here.
 *
 *  TT-1B (W5 unification): each row carries the picker's badge glyph,
 *  derived through the SAME projection the picker uses (session-cards —
 *  one source of truth about durability; a second derivation would be
 *  none). Only the 3 chosen sessions are opened — the read-only listing
 *  rule holds (projectSessionCard's own guarantee), and the cost is
 *  bounded by the list, never the home. */
async function recentSessions(
	id: string,
	agent: { sessions(): { id: string; title: string; events: number; runs: number; updatedAt: number }[]; session(o: { id: string }): Promise<{ pendingApprovals(): readonly unknown[] }> },
): Promise<ResumeMeta[]> {
	const picked = agent
		.sessions()
		.filter((m) => m.id !== id)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 3);
	const store = sessionStoreRef;
	const out: ResumeMeta[] = [];
	for (const m of picked) {
		let badge: string | undefined;
		if (store !== null) {
			const session = await agent.session({ id: m.id });
			const card = projectSessionCard({ id: m.id, updatedAt: m.updatedAt, records: store.load(m.id), asks: session.pendingApprovals().length });
			badge = BADGE_GLYPH[card.badge];
		}
		out.push({ title: m.title, events: m.events, runs: m.runs, updatedAt: m.updatedAt, ...(badge === undefined ? {} : { badge }) });
	}
	return out;
}

/**
 * A area: the coding-agent system prompt — ONE constant, byte-stable for the
 * session's lifetime (D area). Kept under ~80 lines; no template engine.
 */
/** The built-in prompt. Exported for scripts/request-surface.mjs — the
 *  model-side token-rent counter measures the REAL bytes, never a copy. */
export const SYSTEM_PROMPT = `You are kiso, a coding agent. You work in a workspace
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
- Batch independent tool calls into one reply — they run in parallel.
- search_text and list_dir are cheap — locate first, then read ranges
  with read_file offset/limit; never read a whole large file in one call.
- Do not re-read a file you already read unchanged — rely on the earlier
  result.
- When a tool fails, read the error and adjust; do not repeat the same
  call blindly.

Workflow: understand the request, find the relevant code, make the
smallest change that works, then verify with a command (tests/build).
Report what you did in one or two lines per change.`;

/** The project-instructions file names, in priority order (A area). */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
/** Hard cap for injected instructions — truncate and say so. */

/**
 * A area: read the FIRST present instruction file (AGENTS.md preferred) and
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
		return `\n\n=== Project instructions (${name}) ===\n${text.length > 8 * 1024 ? text.slice(0, 8 * 1024) + `\n\n[truncated at ${8 * 1024} chars]` : text}`;
	}
	return "";
}

/** A area: the session's system prompt — the constant plus any project
 *  instructions found in the workspace. Deterministic per cwd. */
export function composeSystemPrompt(cwd: string): string {
	const injected = readProjectInstructions(cwd);
	return injected === "" ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${injected}`;
}

/**
 * E6: the run-start context policy, OFF unless env-armed (invalid values
 * are ABSENT, never a crash — the autoCompactFromEnv convention).
 * The product arming is KISO_CONTEXT_WINDOW → window − POLICY_RESERVE
 * (the window rides the config as windowTokens; the runtime owns the
 * arithmetic — never a fixed low absolute). KISO_POLICY_SUMMARY_TRIGGER
 * survives ONLY as the legacy absolute override when no window is set
 * (bench back-compat); the window wins when both are set.
 * KISO_POLICY_SUMMARY_KEEP (rounds) and KISO_POLICY_SUMMARY_KEEP_TOKENS
 * override the runtime defaults (KEEP_RECENT_ROUNDS = 4,
 * KEEP_TOKENS_DEFAULT = 20,000) — emitted only when set.
 * KISO_POLICY_SUMMARY_MAX_FAILURES overrides the (h) circuit-breaker
 * default (MAX_SUMMARY_FAILURES = 3).
 * KISO_POLICY_DROP=1 switches the armed mode to the crux C arm
 * (mechanical drop — same trigger/keep envs); KISO_POLICY_MICROCOMPACT
 * arms the session-aware override (MIN_TURNS = the no-fire guard).
 */
export function contextPolicyFromEnv(): ContextPolicy | undefined {
	const summaryTrigger = positiveIntEnv("KISO_POLICY_SUMMARY_TRIGGER");
	const contextWindow = positiveIntEnv("KISO_CONTEXT_WINDOW");
	const microcompactTrigger = positiveIntEnv("KISO_POLICY_MICROCOMPACT");
	if (summaryTrigger === undefined && contextWindow === undefined && microcompactTrigger === undefined) return undefined;
	return {
		...(summaryTrigger === undefined && contextWindow === undefined ? {} : {
			[(process.env.KISO_POLICY_DROP === "1" ? "drop" : "summary")]: {
				...(contextWindow !== undefined ? { windowTokens: contextWindow } : summaryTrigger !== undefined ? { triggerTokens: summaryTrigger } : {}),
				...kv("keepRounds", "KISO_POLICY_SUMMARY_KEEP"),
				...kv("keepTokens", "KISO_POLICY_SUMMARY_KEEP_TOKENS"),
				...kv("maxFailures", "KISO_POLICY_SUMMARY_MAX_FAILURES"),
			},
		}),
		...(microcompactTrigger !== undefined ? { microcompact: { thresholdTokens: microcompactTrigger, ...kv("keepResults", "KISO_POLICY_MICROCOMPACT_KEEP"), ...kv("minTurns", "KISO_POLICY_MICROCOMPACT_MIN_TURNS") } } : {}),
	};
}

/** { [key]: value } when the env int is set — the spread-friendly optional field. */
function kv(key: string, env: string): { [key: string]: number } | undefined {
	const v = positiveIntEnv(env);
	return v !== undefined ? { [key]: v } : {};
}

/** Parse a positive-int env var — absent or invalid is undefined (no crash). */
function positiveIntEnv(name: string): number | undefined {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function makeAgent(sessionId: string | undefined, input?: LineInput, modelFlag?: string) {
	// E3: the project-level trust gate runs BEFORE any extension load (the
	// mcp/skills merges must be in the env when the user-level extensions
	// load). Untrusted project capability is never loaded — never silently.
	const project = input !== undefined ? await resolveProjectTrust(input) : await resolveProjectTrust(undefined as unknown as LineInput);

	// R-D 0.1.45 (deliverable B): the first-run scaffold lands AFTER the
	// verdict — pre-trust zero-read/write/scan is absolute. The sessions
	// dir (SessionStore's constructor mkdirs) moved behind the gate too:
	// the trust record is the first home write, the scaffold the second.
	if (isFirstRun()) scaffoldFirstRun();
	const store = new SessionStore(sessionsDir());
	// TUI2-R2 ②/③: the navigation surfaces read through THIS store — one
	// store per process, and the picker/listing never write through it.
	setSessionStore(store);
	// E area: the durable script position — computed AFTER the verdict
	// (fauxSkip's session-log read is a home read: pre-trust zero-read).
	const fauxSkipTurns = sessionId === undefined ? 0 : fauxSkip(sessionId);
	// E1: the startup extension scan — a broken extension fails the process
	// LOUDLY here (loadExtensions throws), never silently.
	const user = await loadExtensions(extensionsDir());
	const proj = project !== null ? await loadProjectExtensions(process.cwd(), user) : [];
	// R-D 0.1.45: the built-in layer registers by module import (builtin.ts)
	// — a user extension may shadow a built-in, a project one may not.
	// KC3.5: built-in #4 (ask) registers ONLY where a human can answer —
	// the panel bridge is the argument, and a non-TTY session has none to
	// give. A piped run's composed tool table therefore cannot contain
	// ask_user (T-Q3: the bench's structural byte-identity proof).
	const builtIn = await builtInLayer(user, proj, input !== undefined && process.stdin.isTTY ? askUi(input) : undefined);
	setExtensionLists(builtIn, user, proj, [...builtIn, ...user, ...proj]);

	// merge round B — the config surface: user config + (trusted) project config,
	// resolved with flags > env > project > user > default. The CLI never
	// imports provider SDKs directly — the runtime's lazy provider
	// resolution owns them (a config profile only ever NAMES an env var for
	// its key; the key itself never sits in a config file).
	const userCfg = loadUserConfig();
	const projectCfg = loadProjectConfig(process.cwd(), project !== null);
	const merged = mergeConfigs(userCfg, projectCfg);
	setMergedConfig(merged);
	setConfigModels(merged.models ?? {});
	setConfiguredWindow(resolveContextWindow(merged));

	const resolved = resolveModel(modelFlag, merged);
	const model = resolved === null ? "faux" : resolved.profile.model;
	if (resolved === null) {
		console.log(
			"[faux mode — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or configure models in ~/.kiso/config.json]\n",
		);
		setCurrentFaux(true);
		setCurrentModelName("faux");
	} else {
		setCurrentFaux(false);
		setCurrentModelName(resolved.name);
	}
	setAgentModel(model); // v2b: the status bar shows it

	// W21: the extensions array is built ONCE per agent and shared with
	// the runtime by reference — the don't-ask-again writer pushes the
	// generated extension into it so a first-time rule joins the chain
	// at the NEXT run (the run's policies are fixed at its start; run.ts
	// re-reads the config's extensions array per run).
	const extensions = [...modeExtensions(), ...loadedExtensions];
	setCurrentAgentExtensions(extensions);

	// E6: the run-start context policy (captured once — exactOptionalPropertyTypes).
	const contextPolicy = contextPolicyFromEnv();
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
		// C area: microcompact is ON by default in the product — threshold =
		// half the model window (KISO_CONTEXT_WINDOW override included;
		// 200k window → 100k tokens). Long sessions compact old read/list/
		// search/shell outputs instead of silently growing past the window.
		microcompact: { thresholdTokens: contextWindowTokens() / 2 },
		// E6: the run-start context policy — OFF unless env-armed (beats the microcompact default when both fire).
		...(contextPolicy !== undefined ? { contextPolicy } : {}),
		maxTurns: 20,
		// Modes: the five tiers join at the CHAIN HEAD, before the user/
		// project extensions (the deny>ask>allow composition keeps a user
		// deny winning over any mode tier — bypass included).
		extensions,
		...(resolved !== null
			? {
					provider: resolved.profile.kind,
					apiKey: resolved.apiKey,
					...(resolved.profile.baseUrl !== undefined ? { baseUrl: resolved.profile.baseUrl } : {}),
					...(resolved.profile.promptCaching !== undefined ? { promptCaching: resolved.profile.promptCaching } : {}),
				}
			: { adapter: createFauxProvider(readFauxScript().slice(fauxSkipTurns)) }),
	};
	return createAgent(definition);
}

/** TUI2-R2 ② — the picker's affordance row: the keys, said where the
 *  keys are useful. */
const PICKER_HINT = "↑↓ pick · ⏎ resumes · type filters · esc";

/**
 * TUI2-R2 ①–③ — the listing's cards. The projection consumes the
 * runtime's own accessors (see session-cards.ts); this is only the
 * plumbing that hands it the store's read side.
 */
async function sessionCards(agent: Awaited<ReturnType<typeof makeAgent>>): Promise<SessionCardView[]> {
	const store = sessionStoreRef;
	if (store === null) return []; // unreachable: makeAgent builds the store first
	return collectSessionCards(agent, (id) => store.load(id));
}

/**
 * TUI2-R2 ② — the resume picker: the band, the keys, the id.
 *
 * The status row carries the picker's own affordance while it is up
 * (a surface teaches its keys where the keys are useful), and the
 * promise settles on the editor's commit — the id the human took, or
 * null when they left. The picker path WRITES NOTHING: the cards are a
 * projection over what is already on disk.
 */
async function pickSession(agent: Awaited<ReturnType<typeof makeAgent>>, input: LineInput): Promise<string | null> {
	const cards = await sessionCards(agent);
	if (cards.length === 0) {
		bodyLog("no sessions yet \u2014 `kiso` starts one");
		return null;
	}
	// a dock-less TTY (rows < 4) has no band to draw the picker in, so the
	// honest answer is the usage line this command has always printed.
	// PH-1a (finding PH-F12): thrown, never process.exit'd from this depth
	// — the old exit(2) skipped main's finally (dock.exit, agent.close,
	// temp cleanup) and could leave the scroll region and lock residue
	// behind. The entry catch translates the error back to exit code 2.
	if (input.pick === undefined || !dock.active) {
		throw new CliUsageError('usage: kiso resume <sessionId> ["prompt"]');
	}
	dock.setStatus("", PICKER_HINT);
	const picked = await new Promise<string | null>((resolve) => {
		input.pick!(() => cards, resolve);
	});
	dock.setStatus("", null);
	return picked;
}

/**
 * TUI2-R2 ⑥ — the BOOT status row.
 *
 * The status line is the product's one persistent claim about itself,
 * and it used to appear after turn ONE: the idle-fresh screen — the
 * screen every session opens on, and the only screen a first-time user
 * sees before deciding whether to type — showed an empty row where the
 * tier, the /mode hint, the model and the remaining context belong.
 *
 * It is painted HERE, at the first moment every field is TRUE: after
 * makeAgent, because that is where the model is resolved. Painting it at
 * dock.enter() — the literally-first frame — would have to name a model
 * nobody had chosen yet, and a status row that guesses is worse than a
 * status row that waits two hundred milliseconds.
 *
 * The meter fields (cache rate, cost) are deliberately absent: an
 * unstarted session has made no requests, and an unmeasured cache is not
 * a 0% cache. chat()'s own paintIdle takes over from here with the same
 * formatter — never a boot-time copy, which would drift from the real
 * row the moment either changed.
 */
function paintBootStatus(session: { log: { all: readonly unknown[] } }): void {
	if (!dock.active) return;
	dock.setStatus(idleStatus(getMode() === "plan" ? "plan (read-only)" : getMode(), agentModel, estimateCtxRatio(session as never)));
}

/** PH-1a (finding PH-F12): a usage error raised from inside the TUI —
 *  main's finally still runs (dock teardown, agent close, temp cleanup)
 *  and the entry catch exits with the historical code 2. */
class CliUsageError extends Error {
	readonly exitCode = 2;
}

/** The /resume+/clear mini-spec — the chat LOOP: chat() ends with a
 *  directive; a switch re-enters it on another session with the SAME
 *  editor. First entry paints the banner; a switch paints one notice
 *  line (the previous conversation stays resumable — clear/switch
 *  never erase history). Faux sessions re-arm the scripted adapter at
 *  the NEW session's durable position, exactly like the picker path. */
async function chatLoop(
	agent: Awaited<ReturnType<typeof makeAgent>>,
	firstId: string,
	input: LineInput,
	autoCompact: Parameters<typeof chat>[3],
): Promise<void> {
	let id = firstId;
	let prev: string | null = null;
	for (;;) {
		const session = await agent.session({ id });
		if (prev === null) {
			bodyLog(`session ${id}\n`);
			extensionsBanner(await recentSessions(id, agent));
		} else {
			bodyLog(`session ${id} (switched — previous: ${prev}, /resume ${prev} returns)\n`);
			if (currentFaux) session.setAdapter(createFauxProvider(readFauxScript().slice(fauxSkip(id))));
		}
		paintBootStatus(session);
		const nav = {
			sessions: () => agent.sessions().map((m) => m.id),
			...(process.stdin.isTTY ? { pick: () => pickSession(agent, input) } : {}),
		};
		const end = await chat(session, currentFaux, input, autoCompact, nav);
		if (end.next === "exit") return;
		prev = id;
		id = end.id;
	}
}

async function main(): Promise<void> {
	// E group (the graceful-exit gate ③, R-G 0.1.48): a terminal closing
	// turns the in-flight stdout/stderr writes into EIO, and node's
	// unhandled 'error' event on the WriteStream kills the process —
	// mid-exit the release never runs (the 60-byte residue the gate
	// caught). The bytes are undeliverable anyway (the terminal is
	// gone): the error must never abort the exit sequence. The listener
	// swallows it — the standard "the stream may die under me" idiom.
	process.stdout.on("error", () => {});
	process.stderr.on("error", () => {});
	// Modes: --mode <name> wins over KISO_MODE — both applied before the
	// first makeAgent (the tier extensions read `current` live). The flag
	// is stripped from the positional args, so it works in any position.
	const args = process.argv.slice(2);
	// PH-1a (finding PH-F2): --help/-h/--version/-v are FLAGS, not session
	// ids. They used to fall through the default case and START A SESSION
	// literally named "--help" (writing ~/.kiso/sessions/--help.jsonl) —
	// the single highest-frequency new-user gesture, failing silently and
	// destructively. Checked FIRST, before any other flag parsing, so
	// `kiso --help` never trips the --model usage error either.
	if (args.some((a) => a === "--help" || a === "-h")) {
		args.length = 0;
		args.push("help");
	} else if (args.some((a) => a === "--version" || a === "-v")) {
		console.log(VERSION);
		return;
	}
	// R3a: -p/--print — the one-shot prompt mode (the F3 adjudication's
	// forward path: a bare quoted argument stays a session id; the
	// PROMPT is explicit). `kiso -p "fix the bug"` runs one turn on a
	// fresh session and exits; an optional trailing session id continues
	// that session one-shot instead. Exit code: 0 only when the turn's
	// terminal is `completed` — scripts can trust it.
	let printPrompt: string | undefined;
	const printIdx = args.findIndex((a) => a === "-p" || a === "--print");
	if (printIdx !== -1) {
		printPrompt = args[printIdx + 1];
		if (printPrompt === undefined) {
			console.error('usage: kiso -p "prompt" [sessionId]');
			process.exit(2);
		}
		args.splice(printIdx, 2);
	}
	// merge round B: --model <profile|provider/model> — the top of the model
	// precedence chain; the value flows into makeAgent's config resolution.
	let modelFlag: string | undefined;
	const modelArgIdx = args.indexOf("--model");
	if (modelArgIdx !== -1) {
		modelFlag = args[modelArgIdx + 1];
		if (modelFlag === undefined) {
			console.error("usage: --model <profile-name|provider/model>");
			process.exit(2);
		}
		args.splice(modelArgIdx, 2);
	}
	// Modes: --mode wins over KISO_MODE, which wins over the USER config's
	// mode (the project config's mode applies later — after the trust gate,
	// inside makeAgent — unless a higher layer already decided).
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
		setMode(modeFromEnv() ?? loadUserConfig()?.mode ?? "default");
	}
	const [command, arg] = args;
	// round 8: faux mode is the keyless demo script — an exhausted script must
	// exit non-zero, never masquerade as a successful provider run. The
	// verdict comes from makeAgent's config resolution now (a config
	// profile can provide a real model with no OPENAI_* env).
	let faux = true;
	let agent: Awaited<ReturnType<typeof makeAgent>> | undefined;

	// v2c: ONE input source per process — the raw-mode editor on a TTY
	// (entered here, dock-bound, trusted before any extension loads),
	// readline elsewhere. The trust question, chat, and resume all read
	// through it; main's finally closes it on every exit path.
	const input = makeLineInput();
	// R3a — cross-session input history: ~/.kiso/history, one line per
	// entry, appended on submit, tail-500 at load (truncated by REWRITE
	// at startup so the file never grows unbounded). Unreadable file =
	// an empty history, silently — recall is a convenience, never a
	// startup risk. Control-character lines never enter the file (the
	// editor's own recall excludes them by construction: a submitted
	// line is printable input).
	if (input.bindHistory !== undefined) {
		const historyPath = join(kisoHome(), "history");
		let seed: string[] = [];
		try {
			seed = readFileSync(historyPath, "utf8").split("\n").filter((l) => l !== "").slice(-500);
			writeFileSync(historyPath, seed.length > 0 ? seed.join("\n") + "\n" : "");
		} catch {
			// no file yet, or unreadable — start empty
		}
		input.bindHistory(seed, (line) => {
			try {
				mkdirSync(kisoHome(), { recursive: true });
				appendFileSync(historyPath, line.replaceAll("\n", " ") + "\n");
			} catch {
				// best-effort — a full disk never breaks a submit
			}
		});
	}
	// PH-1a (finding PH-F6, RESOLVED AS WON'T-FIX-IN-JS — the tcsetattr
	// ruling): SIGTERM/SIGHUP deliberately keep their DEFAULT disposition.
	// A JS handler that restored the terminal was built and then reverted
	// on hard evidence: libuv's uv_tty_set_mode calls tcsetattr with
	// TCSADRAIN, which WAITS for the pty's pending output to drain — on an
	// unread terminal (exactly where signals tend to arrive) the editor's
	// teardown parks the event loop in that ioctl forever, and a CAUGHT
	// signal can only be dispatched by the loop it just parked. Catching
	// the signal therefore converts kernel-guaranteed death into a death
	// that may never happen — strictly worse than a dirty terminal. The
	// default disposition keeps SIGTERM/SIGHUP lethal under every state;
	// a signal death leaves raw mode/mouse on and `reset` is the fix (the
	// same contract kill -9 has always had). A safe restore needs a
	// non-draining native path (bytes-only restore, or tcflush-then-set)
	// — its own mini-spec, not a hotfix.
	// v2d: the body renderer — active only where the dock is (a color
	// TTY with a real size); pipes run it in passthrough, byte-for-byte.
	setBody(
		new Body({
			active: () => process.stdin.isTTY && palette().bold !== "" && (process.stdout.rows ?? 0) >= 4,
			height: () => process.stdout.rows ?? 24,
			width: () => process.stdout.columns ?? 80,
			editCol: () => dock.editCol(),
			onDock: () => dock.redraw(), // v2d-B: the freeze scrolls the dock up — re-pin it
		}),
	);
	try {
		// merge round B: the project config's mode applies AFTER the trust gate
		// (its verdict decides whether the project config exists at all) —
		// unless a higher layer (--mode flag / KISO_MODE) already decided.
		const applyConfigMode = (): void => {
			if (modeFlag === -1 && process.env.KISO_MODE === undefined && mergedConfig.mode !== undefined) setMode(mergedConfig.mode);
		};
		if (printPrompt !== undefined) {
			// the -p flow: recovery-first one-shot, the resume() machinery
			// verbatim (a fresh id makes the recovery a no-op)
			const id = command ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
			agent = await makeAgent(id, input, modelFlag);
			applyConfigMode();
			const session = await agent.session({ id });
			faux = currentFaux;
			await resume(session, printPrompt, faux, input);
			const last = [...session.log.all].reverse().find((e) => e.type === "terminal");
			process.exitCode = last !== undefined && (last as { outcome: { kind: string } }).outcome.kind === "completed" ? 0 : 1;
			return;
		}
		switch (command) {
			case "chat": {
				const id = arg ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				// v2b: the dock (TTY only) wraps the whole session — the
				// trust question, the banner, the body, and the input line.
				dock.enter();
				// E area: a resumed session continues the script at its durable
				// position — never restarts it (fauxSkip).
				agent = await makeAgent(id, input, modelFlag);
				applyConfigMode();
				faux = currentFaux;
				await chatLoop(agent, id, input, resolveAutoCompact(mergedConfig));
				break;
			}
			case "resume": {
				// TUI2-R2 ② — bare `kiso resume` opens the PICKER, but only
				// where there is a human to pick: a pipe keeps today's usage
				// error and today's exit 2, byte for byte. Finding an id used
				// to mean running `kiso sessions` and copying one out by eye;
				// the picker is that step, done by the product.
				if (!arg && !process.stdin.isTTY) {
					console.error("usage: kiso resume <sessionId> [\"prompt\"]");
					process.exit(2);
				}
				// argv[4] is the optional prompt; argv[3] is the session id
				// (argv = [node, script, resume, id, prompt?]).
				const prompt = process.argv[4];
				dock.enter();
				agent = await makeAgent(arg, input, modelFlag);
				applyConfigMode();
				let id = arg;
				if (id === undefined) {
					const picked = await pickSession(agent, input);
					// esc: the human looked and chose not to resume. That is a
					// normal outcome, so it exits 0 with nothing said — never
					// an error, never a session started behind their back.
					if (picked === null) break;
					// the mini-spec (a DECLARED SUPERSESSION of the one-shot
					// picker flow): a PICKED session enters the full REPL —
					// "resume and keep working" no longer requires knowing to
					// type `kiso chat <id>`. The explicit-id one-shot form
					// (`kiso resume <id> ["prompt"]`) keeps its exact bytes.
					faux = currentFaux;
					await chatLoop(agent, picked, input, resolveAutoCompact(mergedConfig));
					break;
				}
				const session = await agent.session({ id });
				faux = currentFaux;
				// E area: the durable script position is computed from the
				// session id, and on the picker path the id did not exist when
				// makeAgent ran. Re-arm the scripted adapter at the PICKED
				// session's position so a picked resume continues its script
				// exactly where `kiso resume <id>` would have.
				if (faux && arg === undefined) session.setAdapter(createFauxProvider(readFauxScript().slice(fauxSkip(id))));
				await resume(session, prompt, faux, input);
				break;
			}
			case "sessions": {
				// R-I-p2 audit (the argument-consistency mandate): the
				// read-only listing NEVER writes through the input, but the
				// trust gate lives inside makeAgent and ASKS through it — on
				// a TTY with a first-discovery .kiso, the undefined input
				// crashed identically to the bare command (finding R-I-p-2,
				// "reading 'question'" on the dock-less branch). The input
				// exists so the gate's ask can be answered; the listing
				// itself never touches it.
				agent = await makeAgent(undefined, input, modelFlag);
				// TUI2-R2 ③ — the same projection the picker renders, printed.
				// The PIPE keeps today's bytes exactly: `kiso sessions` is
				// something scripts read, and a badge column is a TTY-render
				// concern, not a change to a machine interface.
				if (process.stdout.isTTY) {
					const cards = await sessionCards(agent);
					const W = process.stdout.columns ?? 80;
					const col = idColumn(cards);
					const now = Date.now();
					for (const card of cards) console.log(sessionListRow(card, W, now, col));
					console.log(sessionListFooter(cards.length, W));
				} else {
					for (const meta of agent.sessions()) {
						console.log(renderSessionLine(meta));
					}
				}
				break;
			}
			case "help": {
				// PH-1b (finding PH-F21): the CLI must be able to describe its
				// own configuration — the old help listed five commands and
				// stopped, so a new user could never learn from the tool
				// itself how to hand it a key.
				const p = palette();
				console.log(
					`${p.dim}${bannerLines(80, process.stdout.rows ?? 0, VERSION, "").join("\n")}${p.reset}\n\n` +
						"kiso — the coding agent that survives kill -9\n\n" +
						"  kiso [sessionId]         interactive session (default command)\n" +
						"  kiso chat [sessionId]    same as above\n" +
						"  kiso resume              pick a session to continue (TTY picker)\n" +
						"  kiso resume <id> [prompt]   continue a session (one-shot)\n" +
						"  kiso sessions           list durable sessions\n" +
						"  kiso help               this help\n\n" +
						"flags (any position):\n" +
						"  --model <profile|provider/model>   pick the model (also /model in-session)\n" +
						"  --mode <tier>            approval tier: manual|default|accept-edits|plan|bypass\n" +
						"  --version                print the version\n\n" +
						"configuration:\n" +
						"  no key                   keyless faux demo (a scripted four-round session)\n" +
						"  OPENAI_API_KEY           OpenAI-compatible (OPENAI_MODEL, default gpt-4o;\n" +
						"                           OPENAI_BASE_URL for DeepSeek/compat endpoints) — checked first\n" +
						"  ANTHROPIC_API_KEY        Anthropic (ANTHROPIC_MODEL, default claude-sonnet-5)\n" +
						"  ~/.kiso/config.json      named model profiles (keys stay in env vars; see the README)\n",
				);
				break;
			}
			case undefined:
			default: {
				// A area: no subcommand (or any non-command first argument) IS
				// chat — the first argument is the session id.
				const id = command ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				dock.enter();
				// R-I-p2 (finding R-I-p-2): the bare command passes the SAME
				// input source and model flag as chat/resume — the pre-patch
				// call dropped both, and the first-run trust gate read
				// through the undefined input: "Cannot read properties of
				// undefined" at the ask (panelAsk with the dock, question on
				// the dock-less fallback).
				agent = await makeAgent(id, input, modelFlag);
				// finding E4-1's faux resolution rides chatLoop (currentFaux).
				faux = currentFaux;
				await chatLoop(agent, id, input, autoCompactFromEnv());
				break;
			}
		}
	} finally {
		body.close(); // flush the pending frame, stop the heartbeat
		input.close();
		// E group: a NORMAL exit releases the fds and writer locks — the
		// empty released marker is left at the lock path (finding #5: the
		// agent used to be shadowed here; the four branches assign the outer
		// variable now). A signal death skips this and leaves the dead-pid
		// residue — the dead-holder takeover recovers it by design
		// (ADR-0050); the lock never outlives a live writer either way.
		agent?.close();
		// v2b: the dock tears down on EVERY exit path — CSI r resets the
		// scroll region, the cursor lands at the input line, no broken
		// terminal (kill -9 excepted; `reset` saves it).
		dock.exit();
		// finding #8 (P1): extension dispose runs on the same exit path — a
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

// R-D 0.1.45 (deliverable B): main runs ONLY as the entry — the CLI is
// import-clean. The unconditional module-scope run executed the full
// startup under the importing process's argv and REAL home whenever a
// test imported src/index.js for its functions (harmless before the
// first-run scaffold existed; the scaffold WRITES the home). The bin is
// a symlink, so argv[1] is realpathed before the comparison.
/** PH-1a (finding PH-F10): the explicit exit stays (v2a: natural drain is
 *  racy on a TTY — readline leaves the stdio handles active), but on a
 *  PIPE it now waits for both stdio streams to flush first — process.exit
 *  does not drain a pipe's pending async writes, so `kiso sessions | head`
 *  could lose its tail. TTY-GATED on purpose: a pipe's flush callbacks
 *  always settle (the reader drains, or the break surfaces as EPIPE), but
 *  an unread TTY's never do — waiting there would trade a truncation bug
 *  for a hang (the exit-wedge dossier above editorInput). The TTY path keeps the
 *  v2a immediate exit, byte-for-byte. */
function exitFlushed(code: number): void {
	if (process.stdout.isTTY === true) {
		process.exit(code);
	}
	let pending = 2;
	const done = (): void => {
		pending -= 1;
		if (pending === 0) process.exit(code);
	};
	process.stdout.write("", done);
	process.stderr.write("", done);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then(() => exitFlushed(typeof process.exitCode === "number" ? process.exitCode : 0))
		.catch((err) => {
		// round 10: top-level errors are terminal-escaped. v2a: the exit is EXPLICIT
		// — natural drain is racy on a TTY (readline leaves the stdio handles
		// active and the loop sometimes never drains). main's finally already
		// ran (agent.close, dispose, temp cleanup) — nothing is skipped, no
		// lock is left behind; the exit code is honest.
			console.error(escapeTerminal(err instanceof Error ? err.message : String(err)));
			exitFlushed(err instanceof CliUsageError ? err.exitCode : 1);
		});
}
