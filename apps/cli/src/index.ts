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
 *
 * The ergonomics batch B4 (pure move): the interactive pieces live beside this file —
 * chat.ts (the REPL + consumeRun), dispatch.ts (the slash dispatcher),
 * resume.ts, trust-ui.ts (the question surface + E3 merges), faux-glue.ts
 * (the scripted-model plumbing), state.ts (the shared process state).
 * index.ts keeps the entry: banner, input sources, the A area prompt,
 * makeAgent, and main.
 */

import { readFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { Body, Editor, bannerLines, palette, renderSessionLine, type ResumeMeta } from "@vincemakes/kiso-tui";
import { escapeTerminal } from "@vincemakes/kiso-tui";
import {
	createAgent,
	disposeExtensions,
	loadExtensions,
	loadProjectExtensions,
	SessionStore,
	type AgentDefinition,
} from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { MODES, modeExtensions, modeFromEnv, modeSystemPrompt, setMode } from "./mode.js";
import { body, bodyLog, currentFaux, dock, extensionsDir, loadedExtensions, mergedConfig, mergedTempPaths, projectExtensions, sessionsDir, setAgentModel, setBody, setConfigModels, setConfiguredWindow, setCurrentFaux, setCurrentModelName, setExtensionLists, setMergedConfig, userExtensions, VERSION, type LineInput } from "./state.js";
import { interactivePrompt, resolveProjectTrust } from "./trust-ui.js";
import { fauxSkip, readFauxScript } from "./faux-glue.js";
import { autoCompactFromEnv, chat, contextWindowTokens } from "./chat.js";
import { loadProjectConfig, loadUserConfig, mergeConfigs, resolveAutoCompact, resolveContextWindow, resolveModel } from "./config.js";
import { resume } from "./resume.js";

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
		onExpand(cb) {
			editor.onExpand(cb);
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
		// W6: the box's prompt goes light — "› " (the box already says
		// "input lives here"; the line-mode path keeps the brick ▌, so
		// pipe bytes do not change)
		dock.bindInput(() => editor.dockState(), "› ");
		dock.bindMenu(() => editor.menuState()); // v3 §04: the slash-command menu
		return editorInput(editor);
	}
	return readlineInput(createInterface({ input: process.stdin, output: process.stdout }));
}

/** E3: the `[N extensions: ...]` text — user-level names, then project-level
 *  ones marked with `project:`. Byte-identical to the historical text when
 *  no project extensions are loaded. */
function bannerExtensionText(): string {
	const total = userExtensions.length + projectExtensions.length;
	if (total === 0) return "";
	const parts: string[] = [];
	// 0.1.26 (MCP lazy connection): an extension with a live `connecting` flag shows
	// its in-flight state in the banner — "mcp (connecting…)".
	const label = (e: { name: string; connecting?: boolean }): string =>
		e.connecting === true ? `${e.name} (connecting…)` : e.name;
	if (userExtensions.length > 0) parts.push(userExtensions.map(label).join(", "));
	if (projectExtensions.length > 0) parts.push(`project: ${projectExtensions.map(label).join(", ")}`);
	return ` · [${total} extension${total === 1 ? "" : "s"}: ${parts.join(" · ")}]`;
}

/** E1: the startup banner line(s) — TTY: logo + merged extensions + the
 *  W5 resume list as a LIVE banner cell (W1: the tier re-derives on
 *  resize; the resume list re-gates with the tier); off-TTY: the
 *  historical `[N extensions: ...]` standalone line (zero change). */
function extensionsBanner(resume: ResumeMeta[] = []): void {
	if (process.stdout.isTTY) {
		body.banner(VERSION, bannerExtensionText().replace(/^ · /, ""), resume);
		return;
	}
	const text = bannerExtensionText();
	if (text === "") return;
	bodyLog(`${text}\n`);
}

/** W5: the opening-screen resume list — up to 3 recent sessions, newest
 *  first, the CURRENT session excluded (it is not something to pick back
 *  up). Every field already exists behind the store's SessionMeta (the
 *  `kiso sessions` line shows the same data) — only the projection and
 *  the sort live here. */
function recentSessions(id: string, agent: { sessions(): { id: string; title: string; events: number; runs: number; updatedAt: number }[] }): ResumeMeta[] {
	return agent
		.sessions()
		.filter((m) => m.id !== id)
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, 3)
		.map(({ title, events, runs, updatedAt }) => ({ title, events, runs, updatedAt }));
}

/**
 * A area: the coding-agent system prompt — ONE constant, byte-stable for the
 * session's lifetime (D area). Kept under ~80 lines; no template engine.
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
const INSTRUCTION_MAX = 8 * 1024;

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
		const body = text.length > INSTRUCTION_MAX ? text.slice(0, INSTRUCTION_MAX) + `\n\n[truncated at ${INSTRUCTION_MAX} chars]` : text;
		return `\n\n=== Project instructions (${name}) ===\n${body}`;
	}
	return "";
}

/** A area: the session's system prompt — the constant plus any project
 *  instructions found in the workspace. Deterministic per cwd. */
export function composeSystemPrompt(cwd: string): string {
	const injected = readProjectInstructions(cwd);
	return injected === "" ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n${injected}`;
}

async function makeAgent(fauxSkipTurns = 0, input?: LineInput, modelFlag?: string) {
	const store = new SessionStore(sessionsDir());

	// E3: the project-level trust gate runs BEFORE any extension load (the
	// mcp/skills merges must be in the env when the user-level extensions
	// load). Untrusted project capability is never loaded — never silently.
	const project = input !== undefined ? await resolveProjectTrust(input) : await resolveProjectTrust(undefined as unknown as LineInput);
	// E1: the startup extension scan — a broken extension fails the process
	// LOUDLY here (loadExtensions throws), never silently.
	const user = await loadExtensions(extensionsDir());
	if (project !== null) {
		const proj = await loadProjectExtensions(process.cwd(), user);
		setExtensionLists(user, proj, [...user, ...proj]);
	} else {
		setExtensionLists(user, [], user);
	}

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
		maxTurns: 20,
		// Modes: the five tiers join at the CHAIN HEAD, before the user/
		// project extensions (the deny>ask>allow composition keeps a user
		// deny winning over any mode tier — bypass included).
		extensions: [...modeExtensions(), ...loadedExtensions],
		...(resolved !== null
			? {
					provider: resolved.profile.kind,
					apiKey: resolved.apiKey,
					...(resolved.profile.baseUrl !== undefined ? { baseUrl: resolved.profile.baseUrl } : {}),
				}
			: { adapter: createFauxProvider(readFauxScript().slice(fauxSkipTurns)) }),
	};
	return createAgent(definition);
}

async function main(): Promise<void> {
	// Modes: --mode <name> wins over KISO_MODE — both applied before the
	// first makeAgent (the tier extensions read `current` live). The flag
	// is stripped from the positional args, so it works in any position.
	const args = process.argv.slice(2);
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
			if (modeFlag !== -1 || process.env.KISO_MODE !== undefined) return;
			const m = mergedConfig.mode;
			if (m !== undefined) setMode(m);
		};
		switch (command) {
			case "chat": {
				const id = arg ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				// v2b: the dock (TTY only) wraps the whole session — the
				// trust question, the banner, the body, and the input line.
				dock.enter();
				// E area: a resumed session continues the script at its durable
				// position — never restarts it (fauxSkip).
				const agent = await makeAgent(fauxSkip(id), input, modelFlag);
				applyConfigMode();
				const session = await agent.session({ id });
				bodyLog(`session ${id}\n`);
				extensionsBanner(recentSessions(id, agent));
				faux = currentFaux;
				await chat(session, faux, input, resolveAutoCompact(mergedConfig));
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
				const agent = await makeAgent(fauxSkip(arg), input, modelFlag);
				applyConfigMode();
				const session = await agent.session({ id: arg });
				faux = currentFaux;
				await resume(session, prompt, faux, input);
				break;
			}
			case "sessions": {
				const agent = await makeAgent(0, undefined, modelFlag);
				for (const meta of agent.sessions()) {
					console.log(renderSessionLine(meta));
				}
				break;
			}
			case "help": {
				const p = palette();
				console.log(
					`${p.dim}${bannerLines(80, process.stdout.rows ?? 0, VERSION, "").join("\n")}${p.reset}\n\n` +
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
				// A area: no subcommand (or any non-command first argument) IS
				// chat — the first argument is the session id.
				const id = command ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				dock.enter();
				const agent = await makeAgent(fauxSkip(id));
				const session = await agent.session({ id });
				bodyLog(`session ${id}\n`);
				extensionsBanner(recentSessions(id, agent));
				await chat(session, faux, input, autoCompactFromEnv());
				break;
			}
		}
	} finally {
		body.close(); // flush the pending frame, stop the heartbeat
		input.close();
		// E group: every normal and abnormal exit releases the fds and writer
		// locks — no lock file is left behind.
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

main()
	.then(() => process.exit(0))
	.catch((err) => {
		// round 10: top-level errors are terminal-escaped. v2a: the exit is EXPLICIT
		// — natural drain is racy on a TTY (readline leaves the stdio handles
		// active and the loop sometimes never drains). main's finally already
		// ran (agent.close, dispose, temp cleanup) — nothing is skipped, no
		// lock is left behind; the exit code is honest.
		console.error(escapeTerminal(err instanceof Error ? err.message : String(err)));
		process.exit(1);
	});
