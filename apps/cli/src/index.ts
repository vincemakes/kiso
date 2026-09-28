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
 * createCodingAgent, and main.
 */

import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { newSessionId } from "./session-id.js";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { basename, join } from "node:path";
import { Body, Editor, PROMPT, bannerLines, currentGround, currentGroundRgb, parseOscColor, resolveGround, setGround, escapeTerminal, extensionsBannerText, idColumn, interactivePrompt, palette, renderSessionLine, sessionListFooter, sessionListHeader, sessionListRow, sessionListUnknownLine, slashCommandNames, type Rgb, type SessionCardView } from "@vincemakes/kiso-tui";
import { disposeExtensions, SessionStore } from "@vincemakes/kiso-runtime";
import { listSessionSidecars, migrateSummaries, readProfile, summaryMigrationPending } from "@vincemakes/kiso-runtime/internal";
import { skillMenuItems } from "./skill-invoke.js";
import { canonicalPath, hasSession, locateSession, projectLayoutActive, sessionFolders, type SessionFolder, type SessionRoute } from "./projects.js";
import { reverseMigration } from "./session-migration.js";
import { defaultTrashRoot, findEmptySessions, moveToTrash } from "./empty-sessions.js";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { isProtectedPath, protectedIdentity, PROTECTED_REFUSAL } from "@vincemakes/kiso-tools-node";
import { MODES, OFFERED_MODES, getMode, modeFromEnv, setMode } from "./mode.js";
import { activeStoreDir, setActiveStoreDir, agentModel, atFiles, body, bodyLog, kisoHome, workspaceRoot, projectRoot, ownSessionsDir, setOpenSessionFolder, builtInExtensions, currentFaux, dock, loadedExtensions, mergedConfig, mergedTempPaths, modelChoice, projectExtensions, configModels, configuredWindow, agentBaseUrl, currentModelName, currentAgentExtensions, sessionStoreRef, sessionsDir, setAgentModel, setBody, setConfigModels, setConfiguredWindow, setCurrentAgentExtensions, setCurrentFaux, setCurrentModelName, setCurrentProfileName, setExtensionLists, protectedFiles, setMergedConfig, setModelChoice, setSessionStore, userExtensions, VERSION, type LineInput, lastBinding, acceptDrift, setAcceptDrift, loadedSkillsCatalog, queuedSwitchLines } from "./state.js";
import { fauxSkip, readFauxScript } from "./faux-glue.js";
import { barFor, chat, contextWindowTokens, displayCtxRatio, microcompactThresholdFor, statusModelLabel } from "./chat.js";
import { preferences, usePreferences } from "./preferences.js";
import { settingsLayers } from "./state.js";
import { loadUserConfig, resolveAutoCompact } from "./config.js";
import { checkForUpdate, knownUpdate, updateCardLines } from "./update-check.js";
import { tmuxMouseHint } from "./tmux-hint.js";
import { resume } from "./resume.js";
import { paintWindowTitle, setTitleState } from "./window-title.js";
import { projectInstructions } from "./coding-prompt.js";
import { openingFacts } from "./opening.js";
import { resumeTail } from "./resume-tail.js";
import { replayInto } from "./replay.js";
import { armByteTrace } from "./byte-trace.js";
import { tmpdir, homedir } from "node:os";
import { clipboardImage } from "./clipboard.js";
import { cardsFromListings } from "./session-cards.js";
import { createCodingAgent } from "./create-coding-agent.js";
export { contextPolicyFromEnv } from "./create-coding-agent.js";
export { SYSTEM_PROMPT, composeSystemPrompt, readProjectInstructions } from "./coding-prompt.js";

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

/** OR-3: the commands that own their own stdin reader (a hidden key prompt,
 *  an OAuth paste prompt) or read nothing at all — never the editor.
 *  OR-9 adds `update`: npm inherits the terminal for the install's own
 *  progress and prompts, so no editor may hold stdin while it runs. */
const CREDENTIAL_COMMANDS: ReadonlySet<string> = new Set(["login", "logout", "auth", "update"]);

/**
 * Astra F3 — A STORED CREDENTIAL IS NOT A SELECTED MODEL.
 *
 * `kiso login` exits 0, says the key is stored, and stops. With no profile
 * the very next command still announces the demo and runs the scripted
 * listing, so a person who has just signed in reasonably concludes that
 * sign-in failed or is being ignored. Nothing was broken: a credential is
 * stored under a PROVIDER, and a PROFILE is what selects the model that
 * uses it. The gap was that nobody said so at the one moment it matters.
 *
 * These are onboarding EXAMPLES, not a resolution path — nothing here ever
 * decides where a credential goes (that is `effectiveBaseUrl` and
 * `providerIdOf`, and it stays there).
 */
const PROFILE_EXAMPLE: Readonly<Record<string, string>> = {
	anthropic: '{"model":"claude","models":{"claude":{"kind":"anthropic","model":"claude-sonnet-5"}}}',
	openai: '{"model":"gpt","models":{"gpt":{"kind":"openai-compat","model":"gpt-4o"}}}',
	chatgpt: '{"model":"codex","models":{"codex":{"kind":"openai-responses","model":"gpt-5-codex","baseUrl":"https://chatgpt.com/backend-api/codex"}}}',
	deepseek: '{"model":"deepseek","models":{"deepseek":{"kind":"openai-compat","model":"deepseek-flash","baseUrl":"https://api.deepseek.com"}}}',
	zai: '{"model":"glm","models":{"glm":{"kind":"openai-compat","model":"glm-5.3-flash","baseUrl":"https://api.z.ai"}}}',
};

/** The line a fresh sign-in needs, or nothing when profiles already exist.
 *  Read from the USER config alone: a credential command resolves no
 *  project trust, and profiles live in the user's own file. */
function nextStepAfterLogin(provider: string): string {
	let hasProfile = false;
	try {
		hasProfile = Object.keys(loadUserConfig()?.models ?? {}).length > 0;
	} catch {
		// A config that cannot be read is its own loud error elsewhere; here
		// it only means we cannot prove a profile exists, so we say the step.
	}
	if (hasProfile) return "\nkiso already has profiles — `/model` in a session lists them and switches.\n";
	const example = PROFILE_EXAMPLE[provider];
	return (
		`\nThe key is stored, but nothing selects a model yet: a PROFILE does that,` +
		` and without one kiso stays in the keyless faux mode.\nPut one in ${join(kisoHome(), "config.json")}` +
		(example === undefined ? ":\n" : `, for example:\n\n  ${example}\n`) +
		`\nThen run kiso. \`/model\` lists your profiles and switches between them.\n`
	);
}

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
		pick(cards, onPick, here) {
			editor.beginPick(cards, onPick, here);
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
		const editor = new Editor((fromKey) => (dock.active ? dock.redraw(fromKey) : editor.selfRender()));
		// 0.40.1: the installed skills join the `/` menu — read live, so a
		// skill /reload adds is offered on the next keystroke
		editor.bindMenuExtras(() => skillMenuItems(loadedSkillsCatalog(), slashCommandNames()));
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
		const sameRgb = (a: Rgb | null, b: Rgb | null): boolean => a === b || (a !== null && b !== null && a.r === b.r && a.g === b.g && a.b === b.b);
		const rewalk = (): void => {
			const next = resolveGround({ theme: theme(), colorScheme, osc, colorfgbg: process.env.COLORFGBG });
			// Graphite §3.4: the colour the terminal reported rides along,
			// whichever rung decided the ground — the surfaces are derived
			// from it when it is of the same kind (graphite.ts decides).
			const rgb = osc === undefined ? null : parseOscColor(osc);
			// DC-3/DC-14's model: the first frame never waits for a reply.
			// A reply that changes nothing repaints nothing — which is also
			// why two answers that AGREE cost one repaint and not two.
			if (next === currentGround() && sameRgb(rgb, currentGroundRgb())) return;
			setGround(next, rgb);
			body.onGroundChange();
		};
		setGround(resolveGround({ theme: theme(), colorfgbg: process.env.COLORFGBG }));
		// the reply, when there is one, re-walks the ladder WITH it — and
		// `theme` goes in first again, so an explicit answer still wins.
		editor.onOsc((reply) => {
			// Only the answer to the question asked (OSC 11, the background
			// colour) is the ground: any other OSC a terminal sends would
			// otherwise overwrite it.
			if (!reply.startsWith("11;")) return;
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
		// Graphite §7.8 — DECLARED REVERSAL of R2's no-glyph ruling (owner,
		// 2026-09-28): the prompt `›` is back, in the mark column (right-
		// aligned to column 2), so the typed text starts at the content edge
		// with the transcript. The compositor paints the `›` gold.
		const COMPOSER_LEAD = "  \u203a ";
		dock.bindInput(() => editor.dockState(), COMPOSER_LEAD);
		// …and BOTH renderers are live: the dock draws this row while it is
		// active, the editor's own selfRender draws it (with the brick) when
		// it is not. The budget follows whichever is drawing.
		editor.setInputLead(() => (dock.active ? COMPOSER_LEAD : PROMPT));
		// TUI2-R3v2 ②: the click hit-test's wiring — the compositor places
		// the panel's option rows, so the compositor is what the editor asks
		// where they are. Neither side computes the other's geometry.
		editor.bindPanelRows(() => dock.panelOptionRows());
		editor.bindPickWindow(() => dock.visiblePickWindow());
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
 *  with zero disk setup (the task extension, opt-in from E5, was
 *  retired in 0.44.0). */
function bannerExtensionText(): string {
	// KC3.5 slice ⓪ (the extraction): the composition moved to the
	// terminal layer (extensionsBannerText — a pure function of the three
	// name lists, including the "(connecting…)" in-flight label). Which
	// lists exist is the CLI's fact and stays here.
	// 0.40.0: in dontAsk the ask extension is loaded but offers no tool
	// (builtin.ts offInDontAsk) — the banner says so beside the tier that
	// turns it off, rather than listing it as if it could ask.
	const builtIn = builtInExtensions.map((e) => (e.name === "ask" && getMode() === "dontAsk" ? { name: e.name, note: "off in dontAsk" } : e));
	return extensionsBannerText(builtIn, userExtensions, projectExtensions);
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

function extensionsBanner(resumedEvents = 0): void {
	const text = bannerExtensionText();
	if (!process.stdout.isTTY) {
		if (text !== "") bodyLog(`${text}\n`);
		return;
	}
	// Graphite §7.10: the opening states what loaded. The model, the mode
	// and the folder are the status bar's now (§8.9) and are not repeated.
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
	const skills = loadedSkillsCatalog();
	const mcp = loadedExtensions.find((e) => e.name === "mcp") as { tools?: readonly { name: string }[]; connecting?: boolean } | undefined;
	body.banner(VERSION, text.replace(/^ · /, ""), [], {
		resumed: resumedEvents > 0,
		facts: openingFacts({
			resumedEvents,
			rules: projectInstructions(cwd, protectedFiles())?.name ?? null,
			skills: skills === null ? null : { count: skills.entries.length, broken: skills.broken.length },
			mcp: mcp === undefined ? null : { tools: (mcp.tools ?? []).map((t) => t.name), connecting: mcp.connecting === true },
			extensions: { user: userExtensions.map((e) => e.name), project: projectExtensions.map((e) => e.name) },
			// DC-49 — REALPATH on both sides. A symlinked HOME (or a symlinked
			// cwd) compares unequal as raw strings while being the same
			// directory, and the row would then be absent exactly where it is
			// most needed.
			homeWorkspace: realOf(cwd) === realOf(home),
		}),
	});
}

export { workspaceRoot } from "./state.js";

/** TUI2-R2 ② — the picker's affordance row: the keys, said where the
 *  keys are useful. */
const PICKER_HINT = "↑↓ pick · ⏎ resumes · type filters · esc";

/**
 * TUI2-R2 ①–③ — the listing's cards. The projection consumes the
 * runtime's own accessors (see session-cards.ts); this is only the
 * plumbing that hands it the store's read side.
 */
async function sessionCards(_agent: Awaited<ReturnType<typeof createCodingAgent>>, announce: (line: string) => void = (l) => bodyLog(l)): Promise<SessionCardView[]> {
	const store = sessionStoreRef;
	if (store === null) return []; // unreachable: createCodingAgent builds the store first
	const folders = listingFolders();
	// 0.40.0 dogfood (item 2, lead's ruling A): the ONE-TIME migration — the
	// first list after the upgrade reads each legacy log exactly once and
	// writes its summary into the sidecar; announced with its count. Per
	// folder: each carries its own marker.
	const pending = folders.filter((f) => summaryMigrationPending(f.dir));
	const count = pending.reduce((n, f) => n + listSessionSidecars(f.dir).filter((l) => l.summary === null).length, 0);
	if (count > 0) announce(`recording summaries for ${count} older session${count === 1 ? "" : "s"} — once`);
	for (const f of pending) {
		const reader = f.dir === activeStoreDir ? store : new SessionStore(f.dir);
		migrateSummaries(f.dir, (id) => reader.load(id));
	}
	// …and from then on, the SIDECARS only: no log is opened to draw a row.
	// A project folder's sessions are that project's; one without a recorded
	// workspace was placed by inference and says so.
	return cardsFromListings(
		folders.flatMap((f) =>
			listSessionSidecars(f.dir).map((l) =>
				f.kind === "project" ? { ...l, workspace: f.workspace ?? l.workspace, inferred: l.workspace === null } : f.kind === "unknown" ? { ...l, workspace: null } : l,
			),
		),
	);
}

/**
 * 0.40.0 — the folders a listing reads: every project's under the
 * per-project layout (the picker opens on this one, `tab` shows all), and
 * the one folder otherwise. This process's folder is always first, even
 * before its first session exists.
 */
function listingFolders(): SessionFolder[] {
	const here = ownSessionsDir();
	const home = kisoHome();
	if (!projectLayoutActive(home)) return [{ dir: here, workspace: null, kind: "legacy" }];
	const all = sessionFolders(home);
	const mine = all.find((f) => f.dir === here) ?? { dir: here, workspace: projectRoot(), kind: "project" as const };
	return [mine, ...all.filter((f) => f.dir !== here)];
}

/**
 * 0.40.0 (the owner's dogfood: a session of one project resumed from another) —
 * whether a session id may open in this project. Its own folder: yes. A
 * session another project RECORDED: refused, with where to go. One whose
 * project is unknown, or was only inferred, is never refused and never
 * moved (the lead's ruling: a resume changes no placement) — it opens where
 * it is, and the line says the tools work here. A pure read. `null` = not
 * found anywhere (the caller's own rule applies: a new session, or "no
 * such session").
 */
export function routeSession(id: string): SessionRoute | null {
	const own = ownSessionsDir();
	if (hasSession(own, id)) return { kind: "here" };
	const home = kisoHome();
	if (!projectLayoutActive(home)) return null;
	const found = locateSession(home, id, own);
	if (found === null) return null;
	const profile = readProfile(found.dir, id);
	const recorded = profile.kind === "ok" && profile.profile.workspace !== null ? canonicalPath(profile.profile.workspace) : null;
	const cwd = projectRoot();
	const owner = found.kind === "project" ? (found.workspace ?? recorded) : recorded;
	if (recorded !== null && owner !== null && owner !== cwd) {
		return { kind: "refused", line: `this session belongs to ${tildeOf(owner)} — cd there to resume it` };
	}
	// recorded here, and still in the legacy folder (open elsewhere when the
	// move ran): nothing to warn about
	if (recorded !== null) return { kind: "elsewhere", dir: found.dir, line: null };
	const inferred = found.kind === "project" && owner !== null ? `workspace inferred as ${tildeOf(owner)}, never recorded` : "workspace unknown";
	return { kind: "elsewhere", dir: found.dir, line: `${inferred} — tools work in ${tildeOf(workspaceRoot())}` };
}

/** The folder a session opens in: the one the store is on when it holds
 *  it, else this project's, else where the route found it. A new id opens
 *  in this project's folder. */
function sessionFolderOf(id: string): string {
	if (hasSession(activeStoreDir, id)) return activeStoreDir;
	const route = routeSession(id);
	return route?.kind === "elsewhere" ? route.dir : ownSessionsDir();
}

/** The workspace a listing is scoped to: a project folder's identity under
 *  the per-project layout, the recorded realpath in one pinned folder. */
function scopeRoot(): string {
	return projectLayoutActive(kisoHome()) ? projectRoot() : workspaceRoot();
}

function tildeOf(path: string): string {
	const home = homedir();
	return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** The explicit-id doors (`chat <id>`, `resume <id>`, `-p … <id>`), BEFORE
 *  createCodingAgent builds the store: a refusal is the entry's error (the line on
 *  stderr, exit 2); a session in another folder opens there. Returns the
 *  line to say once the session is up. */
function enterRouted(id: string): string | null {
	const route = routeSession(id);
	if (route === null || route.kind === "here") return null;
	if (route.kind === "refused") throw new CliUsageError(route.line);
	setOpenSessionFolder(route.dir);
	return route.line;
}

function sayRouteLine(line: string | null): void {
	if (line === null) return;
	if (process.stdout.isTTY) bodyLog(line);
	else process.stderr.write(`${line}\n`);
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
async function pickSession(agent: Awaited<ReturnType<typeof createCodingAgent>>, input: LineInput): Promise<string | null> {
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
		// 0.40.0: scoped to the running workspace; tab flips to all
		input.pick!(() => cards, resolve, scopeRoot());
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
 * createCodingAgent, because that is where the model is resolved. Painting it at
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
/**
 * ADR-0055 Amendment 1 (the owner, 2026-09-18): `autoCompact` — the
 * between-turn ratio, from config or KISO_AUTO_COMPACT — is RETIRED. The
 * in-run tiers compact inside a run and before its first request, which is
 * everything it did and more. 0.40.0 accepts it, ignores it and says so
 * once; 0.41.0 removes it.
 */
let autoCompactNoticed = false;
function retiredAutoCompact(merged: Parameters<typeof resolveAutoCompact>[0]): undefined {
	if (!autoCompactNoticed && (process.env.KISO_AUTO_COMPACT !== undefined || resolveAutoCompact(merged) !== undefined)) {
		autoCompactNoticed = true;
		console.error("[autoCompact] retired in 0.40.0 — compaction now runs inside a run, by tiers; this setting is ignored and goes in 0.41.0");
	}
	return undefined;
}

/**
 * CTX-1 (Astra F34-1): EVERY entry point that opens a session must bind the
 * policy that follows the session's OWN model.
 *
 * `agent.session()` restores the model recorded in the durable profile —
 * any model that session ever used, not necessarily the one this process
 * started on. The display and the compaction threshold are both derived
 * from it, so both belong here.
 *
 * The first fix put these two lines in chatLoop only. `kiso resume <id>`
 * and `kiso -p <text> <id>` open through their own paths, restored the
 * model, and kept the STARTUP threshold: a session recorded on a 1M model,
 * resumed from a 200k start, cleared its tool results at 100,000 while the
 * interactive entry point cleared at 500,000. Three doors, one of them
 * fixed, is the same defect with a smaller blast radius.
 *
 * The pair is passed EXPLICITLY, never read back out of the display state
 * set on the line above: depending on two lines staying in order is how the
 * threshold got stuck in the first place.
 */
function bindRestoredSession(session: {
	readonly model: string;
	readonly baseUrl: string | undefined;
	readonly driftAcknowledgement?: {
		readonly reasons: readonly string[];
		readonly reasoningReset: { readonly thinking: string; readonly effort: string };
	} | null;
	setMicrocompactThreshold(n: number): void;
	setContextWindow(n: number): void;
}): void {
	// 0.40.1 (the owner's ruling of 2026-09-21): a changed binding is neither
	// blocked nor "acknowledged" — it is recorded as the next revision under
	// the CURRENT configuration, and this ONE line says which binding and why
	// (the owner-ruled reasoning reset rides with it, silently until 0.40.0).
	const ack = session.driftAcknowledgement ?? null;
	if (ack !== null) {
		const was = ack.reasoningReset;
		const prior = [was.effort !== "default" ? `effort ${was.effort}` : "", was.thinking !== "default" ? `thinking ${was.thinking}` : ""].filter((s) => s !== "").join(", ");
		bodyLog(`binding changed — now on ${session.model}: ${ack.reasons.join("; ")}; reasoning reset to defaults${prior === "" ? "" : ` (was ${prior})`}`);
	}
	setAgentModel(session.model, session.baseUrl);
	session.setMicrocompactThreshold(
		microcompactThresholdFor({
			model: session.model,
			...(session.baseUrl !== undefined ? { baseUrl: session.baseUrl } : {}),
		}),
	);
	session.setContextWindow(contextWindowTokens({ model: session.model, ...(session.baseUrl !== undefined ? { baseUrl: session.baseUrl } : {}) }));
}

function paintBootStatus(session: { log: { all: readonly unknown[] }; reasoning?: { readonly effort: string } }): void {
	if (!dock.active) return;
	// Graphite §8.9: the boot row is the status bar — the same builder the
	// idle and running rows use (it used to drop `floor off`, the one fact
	// the boot row most needs when it is true).
	dock.setBar(barFor(session as never));
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
/** §2.5 — how many skills are IN FORCE, taken from the extension that
 *  indexed them rather than by walking the directory again. The first
 *  version re-scanned `KISO_SKILLS_DIR` for one number in one log line,
 *  which is a second answer to a question already answered and free to
 *  disagree with the first (lead's review of 5bee644, observation 2).
 *  An extension that reports no count is reported as none, never guessed. */
function skillCount(): number {
	// `skills` is declared on the extension's own published type
	// (extensions/skills/index.d.ts), not invented here.
	const skills = loadedExtensions.find((e) => e.name === "skills") as ({ skills?: number } | undefined);
	return skills?.skills ?? 0;
}

/**
 * §2.5 — the reload: the agent is CONSTRUCTED AGAIN on the same session.
 *
 * Nothing short of this reloads the whole surface. `run.ts` composes the
 * system prompt and the approval chain per run, so mutating the shared
 * extensions array reaches those — but the tool registry is built in the
 * agent's constructor and has no unregister, and hooks are frozen into
 * the session's config. Half a reload is worse than none: a prompt that
 * announces a skill whose tool is not in the table is the DC-19 family.
 *
 * LOAD FIRST, SWAP ONLY ON SUCCESS. `loadExtensions` is deliberately
 * loud, so tearing the old agent down first would leave a typo in an
 * extension holding a live session with no agent and no way back. The
 * cost is that two sets of MCP servers are briefly alive; a stdio server
 * holding an exclusive resource — a port, a lock — fails to start twice
 * and so fails the reload cleanly, which is the honest outcome.
 *
 * The conversation survives because the id does not change and its truth
 * is the durable log on disk. The record never moves: a reload is
 * invisible in it, because nothing the model said or did changes.
 */
async function reloadAgent(
	old: Awaited<ReturnType<typeof createCodingAgent>>,
	id: string,
	input: LineInput,
	announce = true,
): Promise<Awaited<ReturnType<typeof createCodingAgent>>> {
	// Snapshot BEFORE createCodingAgent: it overwrites every one of these, so the
	// old set would be unreachable by the time we needed to dispose it.
	const oldLoaded = loadedExtensions;
	const oldBuiltIn = builtInExtensions;
	const oldUser = userExtensions;
	const oldProject = projectExtensions;
	const oldTemps = mergedTempPaths.splice(0);
	// createCodingAgent publishes the config side BEFORE it can fail on the model,
	// so a failure past the extension load would leave a NEW window, model
	// name and profile table beside the OLD agent — and the failure line
	// says nothing changed. Rather than soften the line, the snapshot makes
	// it true: a failed reload is atomic, which is what load-then-swap
	// promises. (Lead's review of 5bee644, observation 1.)
	const oldCfg = {
		// RL-F6: createCodingAgent publishes this BEFORE createAgent, and createAgent
		// throws on a tool-name collision — a user extension exposing
		// `read_file` is enough — so a failure CAN land after it. Left
		// unrestored, the new array stands beside the old agent, whose config
		// holds the old one by reference, and the don't-ask-again writer
		// mutates whatever this is: a rule granted after a failed reload goes
		// into an array nothing reads. RL-F3's family one level up, and the
		// same symptom — the human grants a rule and is asked again on the
		// very next identical call.
		agentExtensions: currentAgentExtensions,
		merged: mergedConfig,
		models: configModels,
		window: configuredWindow,
		faux: currentFaux,
		modelName: currentModelName,
		choice: modelChoice,
		agent: agentModel,
		endpoint: agentBaseUrl,
		delegation: process.env.KISO_DELEGATION_CONFIG_JSON,
	};
	let next: Awaited<ReturnType<typeof createCodingAgent>>;
	try {
		next = await createCodingAgent(id, input, modelChoice);
	} catch (err) {
		// Nothing is swapped. Clean up whatever the failed attempt managed
		// to create, put the old set's own temp paths back so exit still
		// removes them, and restore the lists in case createCodingAgent got far
		// enough to publish new ones.
		for (const p of mergedTempPaths.splice(0)) {
			try {
				rmSync(p, { recursive: true, force: true });
			} catch {
				// best-effort — a survivor is removed by a later startup's sweep (temp-sweep.ts) once this process is gone
			}
		}
		mergedTempPaths.push(...oldTemps);
		setExtensionLists(oldBuiltIn, oldUser, oldProject, oldLoaded);
		setCurrentAgentExtensions(oldCfg.agentExtensions);
		setMergedConfig(oldCfg.merged);
		setConfigModels(oldCfg.models);
		setConfiguredWindow(oldCfg.window);
		setCurrentFaux(oldCfg.faux);
		setCurrentModelName(oldCfg.modelName);
		setCurrentProfileName(null); // the reload snapshot carries no profile name: no mark beats a guessed one
		setModelChoice(oldCfg.choice);
		setAgentModel(oldCfg.agent, oldCfg.endpoint);
		if (oldCfg.delegation === undefined) delete process.env.KISO_DELEGATION_CONFIG_JSON;
		else process.env.KISO_DELEGATION_CONFIG_JSON = oldCfg.delegation;
		bodyLog(`[reload] ${err instanceof Error ? err.message : String(err)} — nothing changed, the previous set is still in force`);
		return old;
	}
	// The new set is built and sound; only now does the old one go.
	old.close();
	await disposeExtensions(oldLoaded);
	for (const p of oldTemps) {
		try {
			rmSync(p, { recursive: true, force: true });
		} catch {
			// best-effort — a survivor is removed by a later startup's sweep (temp-sweep.ts) once this process is gone
		}
	}
	if (announce) bodyLog(`[reload] ${loadedExtensions.length} extensions, ${skillCount()} skills — the conversation is unchanged`);
	return next;
}

async function chatLoop(
	first: Awaited<ReturnType<typeof createCodingAgent>>,
	firstId: string,
	input: LineInput,
	autoCompact: Parameters<typeof chat>[3],
): Promise<void> {
	let id = firstId;
	let prev: string | null = null;
	let agent = first;
	// §2.5: a rebuilt agent re-enters on the SAME conversation, so it prints
	// neither the opening banner nor the "switched — previous" line. The
	// reload said what it did; repeating the session's opening would read
	// as a new session, which is the one thing it is not.
	let rebuilt = false;
	// XP-1: the id of the session that IS open — null until the first open
	// succeeds, and cleared by a refused switch, so one refusal can never
	// recurse into another.
	let opened: string | null = null;
	// XP-1: the re-open that follows a refused switch. The session is the one
	// already on screen, so this step prints neither banner nor tail.
	let refused = false;
	/** DC-57: lines that arrived with a switch command belong to the session being asked for. */
	let seed: readonly string[] = [];
	for (;;) {
		// 0.40.0 (the lead's ruling): a session opens in the folder that holds
		// it, never moved — a switch that crosses folders rebuilds the agent
		// on the other folder's store, and one back rebuilds it on this
		// project's. A failed rebuild switches nothing.
		const folder = sessionFolderOf(id);
		if (folder !== activeStoreDir) {
			const was = { dir: activeStoreDir, store: sessionStoreRef };
			setOpenSessionFolder(folder === ownSessionsDir() ? null : folder);
			const next = await reloadAgent(agent, id, input, false);
			if (next === agent) {
				// createCodingAgent may have built the new store before it failed
				setActiveStoreDir(was.dir);
				if (was.store !== null) setSessionStore(was.store);
				setOpenSessionFolder(was.dir === ownSessionsDir() ? null : was.dir);
				if (prev === null) return;
				id = prev;
				rebuilt = true;
				continue;
			}
			agent = next;
		}
		let session: Awaited<ReturnType<typeof agent.session>>;
		try {
			session = await agent.session({ id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
		} catch (err) {
			// The profile contract's BLOCKED cases — a sidecar that cannot be
			// read, an XP-era log without one — belong to the ENTRY: nothing is
			// on screen yet, and the message says what to do. An in-session
			// SWITCH is a LINE: it switches NOTHING and the session you were in
			// stays open. The throw used to escape chatLoop, which killed the
			// REPL and left the session that was open behind with no log at all
			// (announced once, then empty and unopenable). Every refusal this
			// open can throw is treated the same way — the message itself is
			// what says what to do about it.
			if (opened === null) throw err;
			bodyLog(escapeTerminal((err as Error).message));
			// DC-57's other half + DC-55 (the owner's ruling of 2026-09-21,
			// option ①): the lines that arrived WITH the refused switch were aimed
			// at a session that EXISTS and could not be opened. They are NOT run
			// here — a departing session never answers lines meant for the target —
			// and not dropped in silence either: what was held is printed, so
			// nothing vanishes without the person seeing it. (Leaving them in the
			// queue would hand them to the old session on its next entry, which is
			// the thing this ruling forbids.)
			seed = [];
			const held = queuedSwitchLines.splice(0);
			if (held.length > 0) {
				bodyLog(`[${held.length} line${held.length === 1 ? "" : "s"} held back — the switch was refused, so nothing was run]`);
				for (const line of held) bodyLog(`  ${escapeTerminal(line)}`);
			}
			id = opened; // the switch is undone
			opened = null;
			refused = true;
			continue;
		}
		opened = id;
		if (rebuilt) {
			rebuilt = false;
		} else if (refused) {
			refused = false; // back in the session that was already on screen
		} else if (prev === null) {
			bodyLog(`session ${id}\n`);
			// REL-0152-D5: a session with history says what that history WAS.
			// Resuming used to print this one line and drop you at an empty
			// prompt inside a conversation with thousands of events — the
			// durable log was right there and none of it was shown. Empty for
			// a fresh session, so `kiso chat` is byte-identical.
			showResumeTail(session.log.all);
			// R2 (owner, 2026-08-27): the resume list is NOT on the opening
			// screen. `/resume` is where you go looking for a session; the
			// opening's job is to say what THIS one is.
			//
			// It takes DC-8 with it: building those rows opened the three most
			// recent sessions just to draw a badge, and `agent.session()`
			// throws on profile drift — so one drifted session anywhere in the
			// history stopped kiso from starting at all.
			extensionsBanner(session.log.all.length);
			// OR-9 (owner, 2026-09-09): the update card under the banner, at
			// EVERY start while a newer version is known — §7.10's once-only
			// line is superseded. What the cache knows is painted NOW, with
			// no request, so the card is part of the opening rather than a
			// late arrival; the check itself stays FIRED AND FORGOTTEN — the
			// banner is already on screen and it never delays it — and it
			// paints only a version the boot did not know.
			const known = knownUpdate(updateDeps());
			if (known !== null) paintUpdateCard(known);
			// DC-59: under tmux without `mouse on`, say why a scroll walks the
			// history — once, at start, only when it is knowable.
			const tmuxHint = tmuxMouseHint(process.env, () => {
				const r = spawnSync("tmux", ["show", "-gv", "mouse"], { encoding: "utf8", timeout: 500 });
				return r.status === 0 ? r.stdout.trim() : null;
			});
			if (tmuxHint !== null) body.notice(tmuxHint);
			void announceUpdate();
		} else {
			bodyLog(`session ${id} (switched — previous: ${prev}, /resume ${prev} returns)\n`);
			showResumeTail(session.log.all);
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
		// CTX-1: the restored session's own model decides the display AND
		// the threshold. One step, shared by all three entry points.
		bindRestoredSession(session);
		setCurrentModelName(session.model);
		// A SWITCH knows only a model id here — nothing that names the profile —
		// so the mark is cleared rather than guessed. A FRESH start keeps what
		// createCodingAgent resolved from `--model <profile>`, which is the one place
		// the name is known (prev is null only on the first entry).
		if (prev !== null) setCurrentProfileName(null);
		paintBootStatus(session);
		// The terminal's window title, HERE for the same reason the three
		// lines above are here: this is the one step all three entry points
		// share (first start, `/resume <id>`, a switch), so a tab can never
		// be left naming the session the user just left.
		paintWindowTitle(session.log.all);
		const nav = {
			// 0.40.0 dogfood: the ids only — agent.sessions() read every log whole
			// (seconds on the owner's 118 sessions) before /resume could open
			sessions: () => agent.sessionIds(),
			route: (sessionId: string) => routeSession(sessionId),
			...(process.stdin.isTTY ? { pick: () => pickSession(agent, input) } : {}),
		};
		const end = await chat(session, currentFaux, input, autoCompact, nav, seed);
		if (end.next === "exit") return;
		// DC-57: the lines that arrived with the switch command ride INTO the
		// next entry — they were aimed at the session being asked for.
		seed = end.lines ?? [];
		if (end.next === "reload") {
			agent = await reloadAgent(agent, id, input);
			rebuilt = true;
			continue; // the same id, the same conversation, a new agent
		}
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

/**
 * What a resumed session shows (REL-0152-D5, 4c). On the compositor: the
 * durable events replayed into cells — the last two turns in full, the
 * earlier ones in one fold row the ctrl+r viewer reads. Through a pipe
 * there is no viewer and no cell renderer, so the plain text tail stays
 * (DC-51: one call, one cell).
 */
function showResumeTail(events: Parameters<typeof resumeTail>[0]): void {
	const W = process.stdout.columns ?? 80;
	if (dock.active) replayInto(body, events as Parameters<typeof replayInto>[1], W);
	else bodyLog(resumeTail(events, W).join("\n"));
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
	// first createCodingAgent (the tier extensions read `current` live). The flag
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
	// precedence chain; the value flows into createCodingAgent's config resolution.
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
	// inside createCodingAgent — unless a higher layer already decided).
	const modeFlag = args.indexOf("--mode");
	if (modeFlag !== -1) {
		const m = MODES.find((x) => x === args[modeFlag + 1]);
		if (m === undefined) {
			console.error(`unknown mode: ${args[modeFlag + 1]} (tiers: ${OFFERED_MODES.join(", ")})`);
			process.exit(2);
		}
		setMode(m);
		settingsLayers.modeFlag = m;
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
			// the file becomes the turn a model reads — never the credential
			// store. The list here is the store's own path: the user config's
			// protectedPaths is read later, with the agent
			if (isProtectedPath(path, protectedIdentity(protectedFiles()))) throw new CliUsageError(`--task-file: ${path} — ${PROTECTED_REFUSAL}`);
			try {
				taskFile = readFileSync(path, "utf8");
			} catch (err) {
				throw new CliUsageError(`--task-file: cannot read ${path}: ${(err as Error).message}`);
			}
			args.splice(i, 2);
		}
	}
	// 0.40.0: `kiso sessions --all | --current` — the one command that takes
	// them. Parsed only there, so neither ever becomes a session id. Absent
	// = each form's default (TTY: current; pipe: all, today's bytes).
	let listScope: "all" | "current" | undefined;
	let reverseManifest: string | undefined;
	// DC-60: `kiso sessions --prune-empty [--yes]` — list the sessions that
	// never began; with --yes, move them to the Trash
	let pruneEmpty: "list" | "move" | undefined;
	if (args[0] === "sessions") {
		const pe = args.indexOf("--prune-empty");
		if (pe !== -1) {
			args.splice(pe, 1);
			const yes = args.indexOf("--yes");
			if (yes !== -1) args.splice(yes, 1);
			pruneEmpty = yes !== -1 ? "move" : "list";
		}
		// 0.40.0: the undo of the per-project move, named by its manifest
		const r = args.indexOf("--reverse-migration");
		if (r !== -1) {
			reverseManifest = args[r + 1];
			if (reverseManifest === undefined || reverseManifest.startsWith("--")) throw new CliUsageError("kiso sessions --reverse-migration <manifest> — the path the move announced");
			args.splice(r, 2);
		}
		for (const flag of ["--all", "--current"] as const) {
			const i = args.indexOf(flag);
			if (i === -1) continue;
			args.splice(i, 1);
			if (listScope !== undefined && listScope !== flag.slice(2)) throw new CliUsageError("kiso sessions: --all and --current contradict each other");
			listScope = flag.slice(2) as "all" | "current";
		}
	}
	const [command, arg] = args;
	// round 8: faux mode is the keyless demo script — an exhausted script must
	// exit non-zero, never masquerade as a successful provider run. The
	// verdict comes from createCodingAgent's config resolution now (a config
	// profile can provide a real model with no OPENAI_* env).
	let faux = true;
	let agent: Awaited<ReturnType<typeof createCodingAgent>> | undefined;

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
			// R6: the rewrite keeps the file private. It only runs when the
			// file already existed, so this is a trim of the user's own
			// history rather than a creation — the mode is stated so the trim
			// cannot widen it.
			writeFileSync(historyPath, seed.length > 0 ? seed.join("\n") + "\n" : "", { mode: 0o600 });
		} catch {
			// no file yet, or unreadable — start empty
		}
		input.bindHistory(seed, (line) => {
			try {
				// R6: every submitted line lands here, so the history is as
				// private as the session logs — 0700 home, 0600 file, at
				// CREATION. An existing file keeps its mode (not migrated).
				mkdirSync(kisoHome(), { recursive: true, mode: 0o700 });
				appendFileSync(historyPath, line.replaceAll("\n", " ") + "\n", { mode: 0o600 });
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
	// 0.40.6: the choices kiso remembers (preferences.json) — today ctrl+t's
	// thinking display, restored before the first block can be drawn.
	usePreferences();
	body.setThinkingHidden(preferences().thinking === "hidden");
	// REL-0152-D11: pasting an image sends no bytes, so an empty paste is
	// the signal to go and look at the clipboard. What comes back is a
	// PATH, which the turn's attachment scan then picks up exactly as it
	// would a dragged-in file — one mechanism, two ways of naming a file.
	input.onClipboardPaste?.(() => {
		const shot = clipboardImage(tmpdir());
		if (shot === null) {
			// Astra F8: on a platform with no clipboard reader kiso never
			// LOOKED, so "no image on the clipboard" blamed the clipboard for
			// a limit of the build. Say which of the two it is.
			bodyLog(
				process.platform === "darwin"
					? "[no image on the clipboard — ctrl+V attaches one; a file dragged into the window works too]"
					: "[clipboard images are macOS-only — put the image's path in your message instead; a file dragged into the window leaves one]",
			);
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
			const routeLine = command !== undefined ? enterRouted(id) : null;
			agent = await createCodingAgent(id, input, modelFlag);
			applyConfigMode();
			sayRouteLine(routeLine);
			const session = await agent.session({ id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
			bindRestoredSession(session); // CTX-1 (F34-1): the -p door, too
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
				const routeLine = arg !== undefined ? enterRouted(id) : null;
				agent = await createCodingAgent(id, input, modelFlag);
				applyConfigMode();
				sayRouteLine(routeLine);
				faux = currentFaux;
				await chatLoop(agent, id, input, retiredAutoCompact(mergedConfig));
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
				const routeLine = arg !== undefined ? enterRouted(arg) : null;
				agent = await createCodingAgent(arg, input, modelFlag);
				applyConfigMode();
				let id = arg;
				if (id === undefined) {
					const picked = await pickSession(agent, input);
					// esc: the human looked and chose not to resume. That is a
					// normal outcome, so it exits 0 with nothing said — never
					// an error, never a session started behind their back.
					if (picked === null) break;
					// 0.40.0: `tab` lists every project, and another project's
					// recorded session is refused here, with where to go
					const route = routeSession(picked);
					if (route?.kind === "refused") {
						bodyLog(route.line);
						break;
					}
					if (route?.kind === "elsewhere" && route.line !== null) bodyLog(route.line);
					// the mini-spec (a DECLARED SUPERSESSION of the one-shot
					// picker flow): a PICKED session enters the full REPL —
					// "resume and keep working" no longer requires knowing to
					// type `kiso chat <id>`. The explicit-id one-shot form
					// (`kiso resume <id> ["prompt"]`) keeps its exact bytes.
					faux = currentFaux;
					await chatLoop(agent, picked, input, retiredAutoCompact(mergedConfig));
					break;
				}
				sayRouteLine(routeLine);
				const session = await agent.session({ id, ...(acceptDrift() ? { acceptDrift: true } : {}) });
				bindRestoredSession(session); // CTX-1 (F34-1): the explicit-id door
				faux = currentFaux;
				// E area: the durable script position is computed from the
				// session id, and on the picker path the id did not exist when
				// createCodingAgent ran. Re-arm the scripted adapter at the PICKED
				// session's position so a picked resume continues its script
				// exactly where `kiso resume <id>` would have.
				if (faux && arg === undefined) session.setAdapter(createFauxProvider(readFauxScript().slice(fauxSkip(id))));
				// REL-0152-D5 — the same tail on the explicit-id form. NOT on
				// the -p path above: that one's stdout is a machine's input.
				showResumeTail(session.log.all);
				await resume(session, prompt, faux, input);
				break;
			}
			case "sessions": {
				// R-I-p2 audit (the argument-consistency mandate): the
				// read-only listing NEVER writes through the input, but the
				// trust gate lives inside createCodingAgent and ASKS through it — on
				// a TTY with a first-discovery .kiso, the undefined input
				// crashed identically to the bare command (finding R-I-p-2,
				// "reading 'question'" on the dock-less branch). The input
				// exists so the gate's ask can be answered; the listing
				// itself never touches it.
				if (pruneEmpty !== undefined) {
					// DC-60: before createCodingAgent — the scan only reads, and nothing
					// needs an agent to move a file to the Trash
					const { empty, inUse } = findEmptySessions(listingFolders().map((f) => f.dir));
					const n = (k: number, w: string): string => `${k} ${w}${k === 1 ? "" : "s"}`;
					if (empty.length === 0) console.log("no empty sessions");
					else if (pruneEmpty === "list") {
						console.log(`${n(empty.length, "empty session")} — a sidecar and no log; none of them ever ran:`);
						for (const s of empty) console.log(`  ${basename(s.dir)}/${s.id}`);
						console.log("kiso sessions --prune-empty --yes moves them to the Trash");
					} else console.log(`moved ${n(empty.length, "empty session")} to ${moveToTrash(empty, defaultTrashRoot())}`);
					if (inUse > 0) console.log(`skipped ${n(inUse, "empty session")} in use — a live process holds the lock`);
					break;
				}
				if (reverseManifest !== undefined) {
					// before createCodingAgent: its folder preparation would otherwise run
					// the very move this undoes
					const { restored, left } = reverseMigration(kisoHome(), reverseManifest);
					console.log(`moved ${restored} session${restored === 1 ? "" : "s"} back to ${join(kisoHome(), "sessions")}; one folder per project is off until ${join(kisoHome(), "projects", ".migration-reversed")} is removed${left > 0 ? ` — ${left} created since the move stay in their project folders` : ""}`);
					break;
				}
				agent = await createCodingAgent(undefined, input, modelFlag);
				// TUI2-R2 ③ — the same projection the picker renders, printed.
				// The PIPE keeps today's bytes exactly: `kiso sessions` is
				// something scripts read, and a badge column is a TTY-render
				// concern, not a change to a machine interface.
				// 0.40.0 (lead's ruling): the TTY defaults to THIS workspace and
				// says so in a header line with both counts; the PIPE defaults to
				// every session with today's bytes — scripts must not change
				// under them. An explicit --all or --current applies to both.
				const here = scopeRoot();
				if (process.stdout.isTTY) {
					const every = await sessionCards(agent, (l) => console.log(l));
					const all = (listScope ?? "current") === "all";
					const inHere = every.filter((c) => c.workspace === here);
					const cards = all ? every : inHere;
					const W = process.stdout.columns ?? 80;
					const col = idColumn(cards);
					const now = Date.now();
					console.log(sessionListHeader(inHere.length, every.length, all, W));
					// 0.40.1: the sessions with no workspace — one counted line, never
					// listed, unless --all
					if (!all) {
						const unknownLine = sessionListUnknownLine(every.filter((c) => c.workspace === null).length, W);
						if (unknownLine !== "") console.log(unknownLine);
					}
					for (const card of cards) console.log(sessionListRow(card, W, now, col, all ? here : null));
					console.log(sessionListFooter(cards.length, W));
				} else {
					// 0.40.0: every folder's sessions, merged in id order — today's
					// bytes; --current is this project's folder (in a single pinned
					// folder, the sessions that recorded this workspace)
					const folders = listingFolders();
					const single = folders.length === 1 && folders[0]!.kind === "legacy";
					const workspaceOf = (id: string): string | null => {
						const r = readProfile(sessionsDir(), id);
						return r.kind === "ok" ? r.profile.workspace : null;
					};
					const metas = folders
						.filter((f) => listScope !== "current" || single || f.dir === sessionsDir())
						.flatMap((f) => (f.dir === sessionsDir() ? agent!.sessions() : new SessionStore(f.dir).list()))
						.sort((a, b) => a.id.localeCompare(b.id));
					for (const meta of metas) {
						if (listScope === "current" && single && workspaceOf(meta.id) !== here) continue;
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
				const { KNOWN_PROVIDERS, OAUTH_PROVIDERS, authPath, deleteCredential, endpointCredentialId, maskSecret, providerIdOf, readAuthFile, setCredential } = await import("./auth/credentials.js");
				const provider = arg;
				if (provider === "--endpoint" && command !== "auth") {
					// 0.40.6: a gateway's own key, stored for its ORIGIN and sent
					// there alone (credentials.ts endpointCredentialId) — so a
					// gateway profile starts from plain `kiso`, no env var on the
					// command line. The key still never comes from an argument.
					const url = args[2];
					const id = endpointCredentialId(url);
					if (id === null) throw new CliUsageError(`kiso ${command} --endpoint <url> — an http(s) URL, e.g. https://gateway.example/v1`);
					const origin = id.slice("endpoint:".length);
					const vendor = ["openai-compat", "anthropic", "openai-responses"].map((k) => providerIdOf(k, url)).find((v) => v !== null);
					if (vendor !== undefined && vendor !== null) throw new CliUsageError(`${origin} is ${vendor}'s own endpoint — run \`kiso ${command} ${vendor}\``);
					if (command === "logout") {
						const had = deleteCredential(id);
						process.stdout.write(had ? `removed the key for ${origin}\n` : `nothing stored for ${origin}\n`);
						break;
					}
					const key = (await readSecret(`API key for ${origin}: `)).trim();
					if (key === "") throw new CliUsageError(`kiso login --endpoint ${origin}: no key given`);
					setCredential(id, { type: "api-key", key, savedAt: Date.now() });
					process.stdout.write(`stored an API key for ${origin} (${maskSecret(key)}) in ${authPath()} — sent to that origin only; every profile whose baseUrl is on it uses this key before its env var\n`);
					break;
				}
				if (command === "auth") {
					const file = readAuthFile();
					const rows = Object.entries(file.credentials);
					const lines = [`credentials: ${authPath()}${rows.length === 0 ? " (none stored)" : ""}`];
					for (const [id, cred] of rows) {
						if (cred.type === "api-key") lines.push(`  ${id.padEnd(10)} api-key ${maskSecret(cred.key)}  saved ${new Date(cred.savedAt).toISOString().slice(0, 10)}`);
						else
							lines.push(
								`  ${id.padEnd(10)} oauth   ${cred.accountId ?? ""}  expires ${new Date(cred.expires).toISOString()}${cred.refreshRejectedAt !== undefined ? ` (renewal refused — run kiso login ${id})` : cred.expires < Date.now() ? " (expired — renews on use)" : ""}`,
							);
					}
					const envs = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"].filter((k) => process.env[k] !== undefined);
					lines.push(`env vars set: ${envs.length ? envs.join(", ") : "none"} (a stored credential owns its provider; env applies only when nothing is stored)`);
					process.stdout.write(`${lines.join("\n")}\n`);
					break;
				}
				if (provider === undefined || !KNOWN_PROVIDERS.includes(provider)) {
					throw new CliUsageError(`kiso ${command} <provider> — one of: ${KNOWN_PROVIDERS.join(", ")}; or kiso ${command} --endpoint <url> for a gateway`);
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
						process.stdout.write(nextStepAfterLogin(provider));
					} finally {
						rl.close();
					}
					break;
				}
				const key = (await readSecret(`API key for ${provider}: `)).trim();
				if (key === "") throw new CliUsageError(`kiso login ${provider}: no key given`);
				setCredential(provider, { type: "api-key", key, savedAt: Date.now() });
				process.stdout.write(`signed in to ${provider} with an API key (${maskSecret(key)}) — stored in ${authPath()}\n`);
				process.stdout.write(nextStepAfterLogin(provider));
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
					// Graphite §7.10: the opening's head says the tagline already
					`${p.dim}${bannerLines(80, process.stdout.rows ?? 0, VERSION, "").join("\n")}${p.reset}\n\n` +
						"  kiso [sessionId]         interactive session (default command)\n" +
						"  kiso chat [sessionId]    same as above\n" +
						"  kiso resume              pick a session to continue (TTY picker)\n" +
						"  kiso resume <id> [prompt]   continue a session (one-shot)\n" +
						"  kiso sessions [--all|--current]   list durable sessions (a terminal shows this workspace's by default)\n" +
						"  kiso login <provider>    anthropic|openai|deepseek|zai: store an API key (hidden prompt, or stdin when piped);\n" +
						"                           chatgpt: sign in with a ChatGPT subscription (browser; unofficial third-party flow)\n" +
						"  kiso login --endpoint <url>    a gateway: store its API key for that URL's origin only\n" +
						"  kiso logout <provider>   remove the stored credential (or --endpoint <url>)\n" +
						"  kiso auth               list stored credentials (keys masked)\n" +
						"  kiso update             install the latest release (npm i -g @vincemakes/kiso-code@latest)\n" +
						"  kiso help               this help\n\n" +
						"flags (any position):\n" +
						"  --model <profile|provider/model>   pick the model (also /model in-session)\n" +
						"  --mode <tier>            approval tier: default|accept-edits|plan|dontAsk|bypass\n" +
						"  --version                print the version\n\n" +
						"configuration:\n" +
						"  no key                   keyless faux demo (a scripted four-round session)\n" +
						"  OPENAI_API_KEY           OpenAI-compatible (OPENAI_MODEL, default gpt-4o;\n" +
						"                           OPENAI_BASE_URL for DeepSeek/compat endpoints) — checked first\n" +
						"  ANTHROPIC_API_KEY        Anthropic (ANTHROPIC_MODEL, default claude-sonnet-5)\n" +
						"  ~/.kiso/config.json      named model profiles (keys stay in env vars or kiso login; see the README)\n",
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
				agent = await createCodingAgent(id, input, modelFlag);
				// finding E4-1's faux resolution rides chatLoop (currentFaux).
				faux = currentFaux;
				// CX-1 F9 (audit F9): the bare entry resolves autoCompact from
				// the SAME merged config chat/resume use — the env override
				// lives inside the resolver. It used to pass the env-only
				// reader, so a user's config.json autoCompact worked on
				// `kiso chat` and silently vanished on the default entry.
				await chatLoop(agent, id, input, retiredAutoCompact(mergedConfig));
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
		// Graphite §8.10: a closed session never leaves a working or
		// waiting mark in the tab
		setTitleState("ready");
		// finding #8 (P1): extension dispose runs on the same exit path — a
		// dispose failure prints one line and NEVER changes the exit code.
		await disposeExtensions(loadedExtensions);
		// E3: the merged mcp/skills temp artifacts are best-effort removed on
		// the same exit path — a cleanup failure is silent (tmpdir reaps).
		for (const p of mergedTempPaths) {
			try {
				rmSync(p, { recursive: true, force: true });
			} catch {
				// best-effort — a survivor is removed by a later startup's sweep (temp-sweep.ts) once this process is gone
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
