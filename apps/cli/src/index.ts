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
import { spawn, spawnSync } from "node:child_process";
import { newSessionId } from "./session-id.js";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Body, Editor, PROMPT, bannerLines, currentGround, resolveGround, setGround, escapeTerminal, extensionsBannerText, idColumn, idleStatus, interactivePrompt, palette, renderSessionLine, sessionListFooter, sessionListRow, type ResumeMeta, type SessionCardView } from "@vincemakes/kiso-tui";
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
import { agentModel, atFiles, body, bodyLog, codingToolOptions, kisoHome, builtInExtensions, currentFaux, dock, extensionsDir, loadedExtensions, mergedConfig, mergedTempPaths, projectExtensions, sessionStoreRef, sessionsDir, setAgentModel, setBody, setConfigModels, setConfiguredWindow, setCurrentAgentExtensions, setCurrentFaux, setCurrentModelName, setExtensionLists, setMergedConfig, setSessionStore, userExtensions, VERSION, type LineInput , lastBinding , acceptDrift, setAcceptDrift } from "./state.js";
import { askUi, resolveProjectTrust } from "./trust-ui.js";
import { isFirstRun, scaffoldFirstRun } from "./first-run.js";
import { fauxSkip, readFauxScript } from "./faux-glue.js";
import { chat, contextWindowTokens, displayCtxRatio, statusModelLabel } from "./chat.js";
import { loadProjectConfig, loadUserConfig, mergeConfigs, resolveAutoCompact, resolveContextWindow, resolveModel } from "./config.js";
import { oauthTokenThunk } from "./auth/token.js";
import { checkForUpdate, knownUpdate, updateCardLines } from "./update-check.js";
import { resume } from "./resume.js";
import { resumeTail } from "./resume-tail.js";
import { armByteTrace } from "./byte-trace.js";
import { tmpdir, homedir } from "node:os";
import { clipboardImage } from "./clipboard.js";
import { collectSessionCards, projectSessionCard } from "./session-cards.js";

// The moved exports stay reachable from this entry — the test imports
// (project-trust, coding-agent) never change (B4: zero assertion changes).
export { applyProjectMerges } from "./trust-ui.js";

/** The v2b behavior, unchanged: readline owns the line, SIGINT, and the
 *  prompt. Only ever constructed when stdin is NOT a TTY. The rl starts
 *  consuming stdin at construction (main), so 'line' events are buffered
 *  until chat() wires the handler — pipe input must never be dropped. */
/** CX-1 F5 (audit F5): the task-file input — the file's whole content is
 *  ONE turn, delivered the moment the loop listens, and the input is
 *  closed right after: chat still awaits the in-flight chain before it
 *  exits, so the turn runs to its terminal and nothing else is read.
 *  Built on an EMPTY readline so every other member keeps the pipe
 *  path's exact semantics (auto-denied asks, no chips, no pops). */
/** OR-4: hand a URL to the platform's opener, detached, and never let a
 *  missing or failing opener touch the sign-in — the printed URL is the
 *  path that always works. macOS `open`, Linux `xdg-open`; elsewhere the
 *  URL stays printed (Windows is unsupported by the CLI as a whole). */
function openInBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
	if (opener === null) return;
	try {
		spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		// the URL is on screen; opening it is the person's fallback
	}
}

/** LT-1: the stream watchdog's bound from the environment — a non-negative
 *  number of milliseconds (0 disables it); anything else is ignored. The
 *  PTY rigs use it to trip the watchdog in seconds against a stub that
 *  never finishes a stream. */
function streamIdleFromEnv(): number | undefined {
	const raw = process.env.KISO_STREAM_IDLE_MS;
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** OR-3: the commands that own their own stdin reader (a hidden key prompt,
 *  an OAuth paste prompt) or read nothing at all — never the editor.
 *  OR-9 adds `update`: npm inherits the terminal for the install's own
 *  progress and prompts, so no editor may hold stdin while it runs. */
const CREDENTIAL_COMMANDS: ReadonlySet<string> = new Set(["login", "logout", "auth", "update"]);

/** OR-9: the one install command the README gives, which `kiso update`
 *  runs and the failure message names. */
const INSTALL_COMMAND = ["npm", "i", "-g", "@vincemakes/kiso-code@latest"] as const;

function taskFileInput(content: string): LineInput {
	const base = readlineInput(createInterface({ input: Readable.from([]), output: process.stdout }));
	return {
		...base,
		literal: true,
		onLine(cb) {
			cb(content);
		},
	};
}

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
			/* readline has no ctrl+o binding — ignored (W15 rides the
			 * editor path only). */
		},
		onThink() {
			/* §2.3: same as ctrl+o above — readline has no binding, and a
			 * dock-less session has no committed rows to reprint. */
		},
		onEditor() {
			/* §2.4: readline has no ctrl+g, and a piped session has no
			 * composer to hand over. */
		},
		externalEdit() {
			/* §2.4: nothing to suspend — this path never took the terminal. */
		},
		onCopy() {
			/* readline has no ctrl+x binding — ignored. `/copy` still
			 * works here: it is a typed command, not a key. */
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
		onThink(cb) {
			editor.onThink(cb);
		},
		onEditor(cb) {
			editor.onEditor(cb);
		},
		externalEdit(edit) {
			editor.externalEdit(edit);
		},
		onCopy(cb) {
			editor.onCopy(cb);
		},
		// KC2 §2: the redirect gesture — the editor decides WHEN (the
		// same-chunk pair, the precedence gate); chat decides what it MEANS.
		onRedirect(cb) {
			editor.onRedirect(cb);
		},
		onClipboardPaste(cb) {
			editor.onClipboardPaste(cb);
		},
		attachments() {
			return editor.attachments();
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
/** The user config's `theme`, read the way the mode is (index.ts's
 *  `loadUserConfig()?.mode`): the ground is settled inside
 *  `makeLineInput`, which runs long before `mergedConfig` exists, so the
 *  merged view is not available and the USER file is the only one that
 *  may carry it anyway (config.ts rejects a project-level theme LOUDLY).
 *  A broken config is not this function's business to report — the
 *  loader is LOUD about that on its own path. */
function userThemeSetting(): string | undefined {
	try {
		return loadUserConfig()?.theme;
	} catch {
		return undefined;
	}
}

function makeLineInput(): LineInput {
	const userTheme = userThemeSetting();
	if (process.stdin.isTTY) {
		const editor = new Editor(() => (dock.active ? dock.redraw() : editor.selfRender()));
		editor.enter();
		// DC-3: ask the terminal what its background is, and paint the
		// first frame without waiting for the answer.
		//
		// Every grey in the palette is a claim about the background, and
		// kiso had never established one — inline code was chosen on a dark
		// terminal and measured 1.54:1 on a white one. The question is one
		// write; the answer comes back through the editor, which is already
		// the process's single reader of stdin (DC-7 taught it to swallow
		// OSC rather than type it into the draft). No timer, no second
		// reader, nothing blocking: an answer that never arrives leaves the
		// ground `unknown`, and `unknown` is a supported palette, not a
		// failure — see packages/tui-cells/src/ground.ts.
		// DC-14 (P1): the ladder is walked ONCE AT STARTUP, before the query
		// and independently of it. It used to be walked only inside the
		// reply callback below — so on a terminal that does not answer OSC
		// 11 (tmux does not forward the reply by default), rung 1 never
		// ran: `KISO_THEME=dark` is SETTLED as "an explicit answer always
		// wins" and won nothing. Rung 3 was worse than dead — `COLORFGBG`
		// exists FOR the terminals without OSC 11, and could only ever be
		// consulted when an OSC reply had arrived and been malformed. With
		// §3.2 recording that rung 2 is unmeasured, that was the mainline.
		// The two answers accumulate here; whichever arrives first is used
		// at once, and the ladder decides between them when both have.
		let osc: string | undefined;
		let colorScheme: "dark" | "light" | undefined;
		const theme = (): string | undefined => process.env.KISO_THEME ?? userTheme;
		const rewalk = (): void => {
			const next = resolveGround({ theme: theme(), colorScheme, osc, colorfgbg: process.env.COLORFGBG });
			// DC-3/DC-14's model: the first frame never waits for a reply.
			// A reply that changes nothing repaints nothing — which is also
			// why two answers that AGREE cost one repaint and not two.
			if (next === currentGround()) return;
			setGround(next);
			body.onGroundChange();
		};
		setGround(resolveGround({ theme: theme(), colorfgbg: process.env.COLORFGBG }));
		// the reply, when there is one, re-walks the ladder WITH it — and
		// `theme` goes in first again, so an explicit answer still wins.
		editor.onOsc((reply) => {
			osc = reply;
			rewalk();
		});
		// …and the terminal's OWN account of its scheme, which outranks the
		// luminance kiso would infer from a background colour (§3 rung 2).
		editor.onColorScheme((scheme) => {
			colorScheme = scheme;
			rewalk();
		});
		// The query is COLOUR machinery, so it obeys the colour gate: a piped
		// stdout and NO_COLOR both carry zero ANSI, and an OSC written into a
		// pipe would be the first byte to break that. `palette().bold` is the
		// same test the dock activates on — one gate, not a second opinion.
		// Both questions ride ONE write and ONE gate: `CSI ? 996 n` asks the
		// terminal to report its colour scheme, OSC 11 asks for its
		// background colour. Neither is waited on (§3.2) — a terminal that
		// answers neither leaves the ground `unknown`, which is a supported
		// palette rather than a failure.
		if (palette().bold !== "" && process.stdout.isTTY) process.stdout.write("\x1b[?996n\x1b]11;?\x07");
		// W6: the box's prompt goes light — "› " (the box already says
		// "input lives here"; the line-mode path keeps the brick ▌, so
		// pipe bytes do not change)
		// R2 (owner, 2026-08-27): no prompt glyph. The cursor sits at column
		// one, between the two rules — the rules already say "input lives
		// here", which is the argument W6 made for the box and the only part
		// of it that survives. A prompt character is a third thing saying
		// the same thing, and it cost the row a column.
		// OR-11 (a): ONE literal. The compositor draws this lead and the
		// editor measures its rows against it; two copies is how they came
		// to disagree by two columns in the first place.
		const COMPOSER_LEAD = "";
		dock.bindInput(() => editor.dockState(), COMPOSER_LEAD);
		// …and BOTH renderers are live: the dock draws this row while it is
		// active, the editor's own selfRender draws it (with the brick) when
		// it is not. The budget follows whichever is drawing.
		editor.setInputLead(() => (dock.active ? COMPOSER_LEAD : PROMPT));
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
		// R5: the transcript viewer. The editor reports whether it is up and
		// forwards the commands; the STATE lives in the compositor, because
		// the entries the viewer lists are the compositor's own cells.
		editor.bindViewer(
			() => dock.viewerOpen(),
			(cmd) => {
				if (cmd === "open" || cmd === "close") dock.viewerToggleMode();
				else dock.viewerKey(cmd);
			},
		);
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
/**
 * The update card, when there is one, appended after the opening.
 *
 * Two painters, one card. The boot paints what the CACHE already knows,
 * synchronously, so a known newer version is under the banner on the
 * first frame; the check then runs fired-and-forgotten (at most one
 * request a day) and paints only a version the boot did not. If the check
 * fails, times out, is switched off, or finds nothing newer, it does
 * nothing at all and says nothing about having tried.
 */
/** OR-9: the version this process has already carded — the boot's cache
 *  paint and the async check's answer never both card one version. */
let updateShown: string | null = null;

const updateDeps = () => ({ kisoHome: kisoHome(), version: VERSION, isTTY: process.stdout.isTTY === true, faux: currentFaux });

/** OR-9 (owner, 2026-09-09): the update is a CARD under the banner — a
 *  rule, a bold title, the version with the command that installs it, the
 *  changelog, a rule — the shape the reference shows at every start. The
 *  RAW channel (not `notice`, which strips SGR through escapeTerminal); a
 *  raw cell lands at the transcript's end, never spliced mid-frame. A
 *  declared exception to R2 law 1.1 (a notice wears no edge): a card is
 *  not a notice, and the owner asked for the edges. */
function paintUpdateCard(latest: string): void {
	if (latest === updateShown) return;
	updateShown = latest;
	const p = palette();
	const width = Math.min(process.stdout.columns ?? 80, 80);
	const rule = `${p.dim}${"─".repeat(width)}${p.reset}`;
	const [title, line, changelog] = updateCardLines(latest);
	bodyLog(`${rule}\n${p.bold}${title}${p.reset}\n${line}\n${changelog}\n${rule}`, "words");
}

async function announceUpdate(): Promise<void> {
	try {
		const latest = await checkForUpdate(updateDeps());
		if (latest === null) return;
		paintUpdateCard(latest);
	} catch {
		// belt and braces: checkForUpdate does not throw, and if it ever
		// did, a version check is not a reason to disturb a session.
	}
}

function extensionsBanner(resume: ResumeMeta[] = []): void {
	const text = bannerExtensionText();
	if (!process.stdout.isTTY) {
		if (text !== "") bodyLog(`${text}\n`);
		return;
	}
	// R2: the opening answers the three questions a first screen is asked.
	// The model and the tier come from the same state the status line reads
	// (one source, so the two can never disagree); the workspace is the
	// home-relative cwd, because `~/Desktop/devv/kiso` is what a human
	// calls the place and `/Users/vinve/Desktop/devv/kiso` is what a
	// filesystem calls it.
	const home = homedir();
	const cwd = process.cwd();
	/** DC-49: realpath, falling back to the raw path when it cannot be
	 *  resolved — an unresolvable path is not a match, and throwing here
	 *  would take the banner down over a cosmetic row. */
	const realOf = (dir: string): string => {
		try {
			return realpathSync(dir);
		} catch {
			return dir;
		}
	};
	body.banner(VERSION, text.replace(/^ · /, ""), resume, {
		model: agentModel,
		mode: getMode() === "plan" ? "plan (read-only)" : getMode(),
		cwd: cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd,
		// DC-49 — REALPATH on both sides. A symlinked HOME (or a symlinked
		// cwd) compares unequal as raw strings while being the same
		// directory, and the row would then be absent exactly where it is
		// most needed.
		homeWorkspace: realOf(cwd) === realOf(home),
	});
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
	// DT-1a: what a delegated task may NAME — the configured checks and the
	// model profiles — handed to the (in-process) subagent extension through
	// the environment. A model never supplies a command; it names a check.
	process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: merged.checks ?? {}, profiles: Object.keys(merged.models ?? {}) });
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
	setAgentModel(model, resolved?.profile.baseUrl); // v2b: the status bar shows it; OR-1: the endpoint rides along

	// W21: the extensions array is built ONCE per agent and shared with
	// the runtime by reference — the don't-ask-again writer pushes the
	// generated extension into it so a first-time rule joins the chain
	// at the NEXT run (the run's policies are fixed at its start; run.ts
	// re-reads the config's extensions array per run).
	const extensions = [...modeExtensions(), ...loadedExtensions];
	setCurrentAgentExtensions(extensions);

	// E6: the run-start context policy (captured once — exactOptionalPropertyTypes).
	const contextPolicy = contextPolicyFromEnv();
	const idleFromEnv = streamIdleFromEnv(); // read once: a narrowed const, not a call per spread
	const definition: AgentDefinition = {
		model,
		store,
		// Area 5: the coding tools are bound to the workspace — every path
		// they touch is canonicalized inside cwd, escapes are refused.
		tools: [...createCodingTools(codingToolOptions())], // DC-49 — the options live in state.ts, shared with the `!` command's runner
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
		// R3e (owner ruling, 2026-08-28): NO turn limit on an interactive
		// session. This was `maxTurns: 20`, hardcoded on 2026-08-03 with no
		// stated reason and no way to change it — and it was the thing that
		// stopped a real 43-call session dead, mid-task, in silence. The
		// field survives for the callers that want a bound (subagents, the
		// SDK, `kiso run`); the interactive front door does not set one.
		// Modes: the five tiers join at the CHAIN HEAD, before the user/
		// project extensions (the deny>allow>ask composition keeps a user
		// deny winning over any mode tier — bypass included).
		extensions,
		...(resolved !== null
			? {
					provider: resolved.profile.kind,
					// OR-1: exactly one sign-in shape reaches the adapter. An
					// OAuth profile has no key to pass — it passes the thunk
					// the adapter re-resolves per request instead.
					...(resolved.oauthProviderId !== undefined
						? { oauth: oauthTokenThunk(resolved.oauthProviderId) }
						: { apiKey: resolved.apiKey ?? "none" }),
					// OR-1: the ChatGPT backend's cache lane is the SESSION —
					// one conversation's requests share a key, different
					// conversations never do. The one entry point that hands
					// no session id is `kiso sessions`, a read-only listing
					// that streams nothing, so its absence costs no cache.
					...(sessionId !== undefined ? { promptCacheKey: sessionId } : {}),
					...(resolved.profile.baseUrl !== undefined ? { baseUrl: resolved.profile.baseUrl } : {}),
					...(resolved.profile.promptCaching !== undefined ? { promptCaching: resolved.profile.promptCaching } : {}),
					// LT-1: the profile's stream watchdog bound, if it states one
					...(resolved.profile.streamIdleMs !== undefined ? { streamIdleMs: resolved.profile.streamIdleMs } : {}),
				}
			: { adapter: createFauxProvider(readFauxScript().slice(fauxSkipTurns)) }),
		// LT-1: KISO_STREAM_IDLE_MS (the test rigs' knob) beats the profile —
		// the last spread wins, which is why it sits after the profile's.
		...(idleFromEnv !== undefined ? { streamIdleMs: idleFromEnv } : {}),
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
function paintBootStatus(session: { log: { all: readonly unknown[] }; reasoning?: { readonly effort: string } }): void {
	if (!dock.active) return;
	dock.setStatus(idleStatus(getMode() === "plan" ? "plan (read-only)" : getMode(), statusModelLabel(session), displayCtxRatio(session as never)));
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
		const session = await agent.session({ id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
		if (prev === null) {
			bodyLog(`session ${id}\n`);
			// REL-0152-D5: a session with history says what that history WAS.
			// Resuming used to print this one line and drop you at an empty
			// prompt inside a conversation with thousands of events — the
			// durable log was right there and none of it was shown. Empty for
			// a fresh session, so `kiso chat` is byte-identical.
			bodyLog(resumeTail(session.log.all, process.stdout.columns ?? 80).join("\n")); // DC-51: one call, one cell
			// R2 (owner, 2026-08-27): the resume list is NOT on the opening
			// screen. `/resume` is where you go looking for a session; the
			// opening's job is to say what THIS one is.
			//
			// It takes DC-8 with it: building those rows opened the three most
			// recent sessions just to draw a badge, and `agent.session()`
			// throws on profile drift — so one drifted session anywhere in the
			// history stopped kiso from starting at all.
			extensionsBanner();
			// OR-9 (owner, 2026-09-09): the update card under the banner, at
			// EVERY start while a newer version is known — §7.10's once-only
			// line is superseded. What the cache knows is painted NOW, with
			// no request, so the card is part of the opening rather than a
			// late arrival; the check itself stays FIRED AND FORGOTTEN — the
			// banner is already on screen and it never delays it — and it
			// paints only a version the boot did not know.
			const known = knownUpdate(updateDeps());
			if (known !== null) paintUpdateCard(known);
			void announceUpdate();
		} else {
			bodyLog(`session ${id} (switched — previous: ${prev}, /resume ${prev} returns)\n`);
			bodyLog(resumeTail(session.log.all, process.stdout.columns ?? 80).join("\n")); // DC-51: one call, one cell
			if (currentFaux) session.setAdapter(createFauxProvider(readFauxScript().slice(fauxSkip(id))));
		}
		// XP-1 §3.3.6: a /clear-fresh session INHERITS the live selection,
		// recorded as its next revision — clearing context never silently
		// reverts the model.
		const inherited = lastBinding();
		if (session.log.all.length === 0 && inherited !== null && !currentFaux) {
			session.setModelBinding(inherited);
		}
		// XP-1 §2.1: the switched-to session's OWN truth repaints the row —
		// the global display state never outlives the session it described
		// (pre-XP the row kept the previous session's /model selection).
		setAgentModel(session.model, session.baseUrl);
		setCurrentModelName(session.model);
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

/** A secret from the terminal: hidden input on a TTY, the whole of stdin
 *  otherwise (a pipe, a heredoc) — never an argument, which shell history
 *  would keep. */
async function readSecret(prompt: string): Promise<string> {
	if (process.stdin.isTTY !== true) {
		return await new Promise<string>((resolve) => {
			let buf = "";
			process.stdin.setEncoding("utf8");
			process.stdin.on("data", (d: string) => {
				buf += d;
			});
			process.stdin.on("end", () => resolve(buf.split("\n")[0] ?? ""));
			process.stdin.resume();
		});
	}
	return await new Promise<string>((resolve) => {
		let buf = "";
		// OR-3: raw mode BEFORE the prompt — the hidden prompt must be hidden
		// before it is shown. Written the other way round, a key that arrives
		// between the prompt and setRawMode is echoed by the tty line
		// discipline (the auth-tty gate caught it: a driver that types the
		// instant the prompt appears saw the key on screen two runs in three).
		process.stdin.setRawMode(true);
		process.stdout.write(prompt);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");
		const onData = (chunk: string): void => {
			for (const ch of chunk) {
				if (ch === "\r" || ch === "\n") {
					process.stdin.setRawMode(false);
					process.stdin.pause();
					process.stdin.off("data", onData);
					process.stdout.write("\n");
					resolve(buf);
					return;
				}
				if (ch === "\u0003") {
					process.stdin.setRawMode(false);
					process.stdout.write("\n");
					process.exit(130);
				}
				if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
				else buf += ch;
			}
		};
		process.stdin.on("data", onData);
	});
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
	// REL-0152-D12: armed only by KISO_TRACE_BYTES, and armed HERE so the
	// banner and the first frame are in the record. Off by default.
	armByteTrace();
	// Modes: --mode <name> wins over KISO_MODE — both applied before the
	// first makeAgent (the tier extensions read `current` live). The flag
	// is stripped from the positional args, so it works in any position.
	const args = process.argv.slice(2);
	// XP-1: --accept-drift (a flag, never an env var) authorizes opening a
	// session whose recorded profile materially drifted — the
	// acknowledgement is recorded as a new revision by the runtime.
	{
		const i = args.indexOf("--accept-drift");
		if (i !== -1) {
			args.splice(i, 1);
			setAcceptDrift(true);
		}
	}
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
	// CX-1 F5: --task-file <path> — the file is the ONE user turn (the
	// structured child entry). Read BEFORE any session exists: an
	// unreadable file is a usage error with nothing executed.
	let taskFile: string | undefined;
	{
		const i = args.indexOf("--task-file");
		if (i !== -1) {
			const path = args[i + 1];
			if (path === undefined) throw new CliUsageError("--task-file needs a path");
			try {
				taskFile = readFileSync(path, "utf8");
			} catch (err) {
				throw new CliUsageError(`--task-file: cannot read ${path}: ${(err as Error).message}`);
			}
			args.splice(i, 2);
		}
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
	// OR-3 (owner, 2026-09-09): the credential commands never read the shared
	// line input, and on a TTY makeLineInput() enters the raw-mode editor and
	// sends the ground probe (CSI ?996n + OSC 11) BEFORE the command switch.
	// `kiso login chatgpt` then had two readers on stdin: the editor swallowed
	// the keystrokes, the terminal's OSC reply was typed into the login's own
	// readline, the "open this URL" line vanished under the dock's repaint,
	// and the sign-in never completed. These commands get an input over an
	// EMPTY readable instead — no editor, no probe, stdin untouched — so the
	// hidden key prompt and the OAuth paste prompt are the only readers.
	const input =
		taskFile !== undefined
			? taskFileInput(taskFile)
			: CREDENTIAL_COMMANDS.has(command ?? "")
				? readlineInput(createInterface({ input: Readable.from([]), output: process.stdout }))
				: makeLineInput();
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
	// REL-0152-D11: pasting an image sends no bytes, so an empty paste is
	// the signal to go and look at the clipboard. What comes back is a
	// PATH, which the turn's attachment scan then picks up exactly as it
	// would a dragged-in file — one mechanism, two ways of naming a file.
	input.onClipboardPaste?.(() => {
		const shot = clipboardImage(tmpdir());
		if (shot === null) {
			bodyLog("[no image on the clipboard — ctrl+V attaches one; a file dragged into the window works too]");
			return null;
		}
		return shot;
	});
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
			const id = command ?? newSessionId(sessionsDir());
			agent = await makeAgent(id, input, modelFlag);
			applyConfigMode();
			const session = await agent.session({ id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
			faux = currentFaux;
			await resume(session, printPrompt, faux, input);
			const last = [...session.log.all].reverse().find((e) => e.type === "terminal");
			process.exitCode = last !== undefined && (last as { outcome: { kind: string } }).outcome.kind === "completed" ? 0 : 1;
			return;
		}
		switch (command) {
			case "chat": {
				const id = arg ?? newSessionId(sessionsDir());
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
				const session = await agent.session({ id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
				faux = currentFaux;
				// E area: the durable script position is computed from the
				// session id, and on the picker path the id did not exist when
				// makeAgent ran. Re-arm the scripted adapter at the PICKED
				// session's position so a picked resume continues its script
				// exactly where `kiso resume <id>` would have.
				if (faux && arg === undefined) session.setAdapter(createFauxProvider(readFauxScript().slice(fauxSkip(id))));
				// REL-0152-D5 — the same tail on the explicit-id form. NOT on
				// the -p path above: that one's stdout is a machine's input.
				bodyLog(resumeTail(session.log.all, process.stdout.columns ?? 80).join("\n")); // DC-51: one call, one cell
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
			case "login":
			case "logout":
			case "auth": {
				// the sign-in plan (2026-09-08), step 1: the credential store.
				// `login <provider>` reads the key from a hidden prompt on a TTY
				// or from stdin otherwise (never from an argument — shell history);
				// `logout <provider>` deletes; `auth` lists, keys masked.
				const { KNOWN_PROVIDERS, OAUTH_PROVIDERS, authPath, deleteCredential, maskSecret, readAuthFile, setCredential } = await import("./auth/credentials.js");
				const provider = arg;
				if (command === "auth") {
					const file = readAuthFile();
					const rows = Object.entries(file.credentials);
					const lines = [`credentials: ${authPath()}${rows.length === 0 ? " (none stored)" : ""}`];
					for (const [id, cred] of rows) {
						if (cred.type === "api-key") lines.push(`  ${id.padEnd(10)} api-key ${maskSecret(cred.key)}  saved ${new Date(cred.savedAt).toISOString().slice(0, 10)}`);
						else lines.push(`  ${id.padEnd(10)} oauth   ${cred.accountId ?? ""}  expires ${new Date(cred.expires).toISOString()}${cred.expires < Date.now() ? " (expired)" : ""}`);
					}
					const envs = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((k) => process.env[k] !== undefined);
					lines.push(`env vars set: ${envs.length ? envs.join(", ") : "none"} (a stored credential owns its provider; env applies only when nothing is stored)`);
					process.stdout.write(`${lines.join("\n")}\n`);
					break;
				}
				if (provider === undefined || !KNOWN_PROVIDERS.includes(provider)) {
					throw new CliUsageError(`kiso ${command} <provider> — one of: ${KNOWN_PROVIDERS.join(", ")}`);
				}
				if (command === "logout") {
					const had = deleteCredential(provider);
					process.stdout.write(had ? `signed out of ${provider}\n` : `nothing stored for ${provider}\n`);
					break;
				}
				if (OAUTH_PROVIDERS.includes(provider)) {
					// the subscription sign-in (plan step 2): the browser flow with a
					// paste path; the callback host/port can be moved by env for tests
					const { chatgptFlow } = await import("./auth/oauth/chatgpt.js");
					const { createInterface } = await import("node:readline");
					const rl = createInterface({ input: process.stdin, output: process.stdout });
					const cbPort = process.env.KISO_OAUTH_CALLBACK_PORT !== undefined ? Number(process.env.KISO_OAUTH_CALLBACK_PORT) : undefined;
					try {
						const cred = await chatgptFlow.login({
							notify: (line) => process.stdout.write(`${line}\n`),
							prompt: (q) => new Promise<string>((resolve) => rl.question(q, resolve)),
							// OR-4: a person at a terminal gets the browser opened for
							// them; a pipe, a test rig or KISO_NO_BROWSER=1 gets the URL only.
							...(process.stdout.isTTY === true && process.env.KISO_NO_BROWSER === undefined ? { open: openInBrowser } : {}),
							...(cbPort !== undefined ? { callback: { host: process.env.KISO_OAUTH_CALLBACK_HOST ?? "127.0.0.1", port: cbPort } } : {}),
							...(process.env.KISO_OAUTH_TOKEN_URL !== undefined ? { tokenUrl: process.env.KISO_OAUTH_TOKEN_URL } : {}),
						});
						setCredential(provider, cred);
						process.stdout.write(`signed in to ${provider} (${chatgptFlow.label}) — account ${cred.accountId ?? "?"}, expires ${new Date(cred.expires).toISOString()} — stored in ${authPath()}\n`);
					} finally {
						rl.close();
					}
					break;
				}
				const key = (await readSecret(`API key for ${provider}: `)).trim();
				if (key === "") throw new CliUsageError(`kiso login ${provider}: no key given`);
				setCredential(provider, { type: "api-key", key, savedAt: Date.now() });
				process.stdout.write(`signed in to ${provider} with an API key (${maskSecret(key)}) — stored in ${authPath()}\n`);
				break;
			}
			case "update": {
				// OR-9: the command the update card names. A thin hand-off to
				// the ONE install command the README gives — npm resolved from
				// PATH, its stdio inherited so its progress, its prompts and
				// its own errors are what the person sees, its exit code the
				// outcome. kiso adds nothing to what npm knows: no version
				// pinning, no registry, no elevation. A failure (a global
				// prefix this user cannot write, a network that is down) is
				// npm's to explain; the message names the manual command so
				// the person can run it with whatever their setup needs.
				const [bin, ...installArgs] = INSTALL_COMMAND;
				const r = spawnSync(bin, installArgs, { stdio: "inherit" });
				if (r.error !== undefined || r.status !== 0) {
					const why = r.error !== undefined ? `could not run npm (${r.error.message})` : `npm exited ${r.status ?? "on a signal"}`;
					process.stderr.write(`kiso update: ${why} — run it yourself: ${INSTALL_COMMAND.join(" ")}\n`);
					process.exitCode = r.status ?? 1;
					break;
				}
				process.stdout.write("kiso updated — the next `kiso` runs the new version\n");
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
						"  kiso login <provider>    anthropic|openai|deepseek|zai: store an API key (hidden prompt, or stdin when piped);\n" +
						"                           chatgpt: sign in with a ChatGPT subscription (browser; unofficial third-party flow)\n" +
						"  kiso logout <provider>   remove the stored credential\n" +
						"  kiso auth               list stored credentials (keys masked)\n" +
						"  kiso update             install the latest release (npm i -g @vincemakes/kiso-code@latest)\n" +
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
				const id = command ?? newSessionId(sessionsDir());
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
				// CX-1 F9 (audit F9): the bare entry resolves autoCompact from
				// the SAME merged config chat/resume use — the env override
				// lives inside the resolver. It used to pass the env-only
				// reader, so a user's config.json autoCompact worked on
				// `kiso chat` and silently vanished on the default entry.
				await chatLoop(agent, id, input, resolveAutoCompact(mergedConfig));
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
