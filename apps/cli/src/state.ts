/**
 * The ergonomics batch B4 — the CLI's shared process state. The module split (dispatch/
 * chat/resume/trust-ui/faux-glue) is a PURE MOVE: every piece that more
 * than one module touches lives here as a live ESM binding. index.ts
 * creates the mutable ones (setBody / setAgentModel / setExtensionLists);
 * the moved modules read and mutate at call time.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AT_CAP, AT_SKIP, Dock, type AtItem, type Body, type PanelVerdict, type PanelView } from "@vincemakes/kiso-tui";
import type { KisoExtension } from "@vincemakes/kiso-runtime";

/** finding #11: KISO_HOME is the ONE root — every default path derives from
 *  it (sessions, trust, extensions, mcp config, skills). The dedicated
 *  env vars (KISO_EXTENSIONS_DIR / KISO_MCP_CONFIG / KISO_SKILLS_DIR)
 *  still override their own path; nothing hard-codes ~/.kiso anymore. */
export function kisoHome(): string {
	return process.env.KISO_HOME ?? join(homedir(), ".kiso");
}

export function sessionsDir(): string {
	return join(kisoHome(), "sessions");
}

/** E1: the extension scan directory — KISO_EXTENSIONS_DIR overrides. */
export function extensionsDir(): string {
	return process.env.KISO_EXTENSIONS_DIR ?? join(kisoHome(), "extensions");
}

/**
 * TUI2-R1 (E) — the /context ledger, read from the session's TRACE
 * SIDECAR (<sessions>/traces/<id>.jsonl).
 *
 * THE PURITY GATE (ADR-0051 §6, ruling R7) IS UNTOUCHED. The trace
 * surface is an observation surface; correctness never reads it, and
 * this reader is on the DISPLAY path only — nothing it returns reaches a
 * recovery plan, a projection or a request. The proof of that is the
 * shape of this function: it is best-effort end to end, and its failure
 * mode is `null`, which renders a sentence rather than a number.
 *
 * The LAST request line is the one that matters: rent is per request,
 * and what the reader wants to know is what the NEXT request will cost,
 * which is what the previous one cost.
 */
export function readContextLedger(sessionId: string, window: number): import("@vincemakes/kiso-tui").ContextLedger | null {
	let last: Record<string, unknown> | null = null;
	try {
		const text = readFileSync(join(sessionsDir(), "traces", `${sessionId}.jsonl`), "utf8");
		for (const line of text.split("\n")) {
			if (line === "") continue;
			try {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				if (parsed.kind === "request") last = parsed;
			} catch {
				// a torn last line (the writer was mid-append) — the ledger is
				// an observation, and a partial one is simply not the answer
			}
		}
	} catch {
		return null; // no sidecar — a session that has not called the model
	}
	if (last === null) return null;
	const rent = Array.isArray(last.rent) ? (last.rent as { surface: string; estTokens: number }[]) : [];
	if (rent.length === 0) return null; // a v1/v2 sidecar carries no rent block (R2-1)
	const sum = (pred: (surface: string) => boolean): number =>
		rent.filter((l) => typeof l.surface === "string" && pred(l.surface)).reduce((a, l) => a + (l.estTokens ?? 0), 0);
	const count = (pred: (surface: string) => boolean): number =>
		rent.filter((l) => typeof l.surface === "string" && pred(l.surface)).length;
	// the skills index is broken out: it is an INDEX of workspace content,
	// not an instruction, and it is the one append whose size is the
	// reader's own doing.
	const isSkills = (s: string): boolean => s === "system:ext:skills";
	const manifest = Array.isArray(last.contextManifest) ? (last.contextManifest as { role: string; estTokens: number }[]) : [];
	const turnSegments = manifest.filter((s) => s.role === "turn" || s.role === "current_turn");
	return {
		window,
		systemPrompt: sum((s) => s === "system:base" || (s.startsWith("system:ext:") && !isSkills(s))),
		systemBase: sum((s) => s === "system:base"),
		appends: count((s) => s.startsWith("system:ext:") && !isSkills(s)),
		toolTable: sum((s) => s.startsWith("tool:")),
		tools: count((s) => s.startsWith("tool:")),
		skillsIndex: sum(isSkills),
		// the ledger records the SURFACE, never its contents — the number
		// of skills is not in it, and 0 tells the renderer to say so.
		skills: 0,
		envelope: sum((s) => s === "envelope"),
		messages: turnSegments.reduce((a, s) => a + (s.estTokens ?? 0), 0),
		turns: turnSegments.length,
	};
}

/**
 * KC3 §5 — the @ picker's file source. Computed PER OPEN: no index, no
 * daemon, no watcher, nothing to invalidate and nothing to go stale.
 * (The editor snapshots the result for the life of one open, so this
 * runs once per `@`, not once per keystroke.)
 *
 * In a git repo, git IS the answer. `ls-files -c -o --exclude-standard`
 * is the tracked files AND the untracked ones that are not ignored, in
 * ONE process: the same set the user's own tooling calls "the project",
 * with every .gitignore in the tree already honoured — and honoured by
 * git rather than by a reimplementation of git's rules. stderr is
 * discarded because "not a git repository" must never land in a live
 * TUI frame.
 *
 * Outside a repo — or with no git on PATH — the bounded walk stands
 * in: it prunes AT_SKIP before descending and stops at AT_CAP + 1
 * entries, the extra entry being what lets the panel's counter SAY it
 * truncated instead of showing the first two thousand files as though
 * they were all of them.
 *
 * Paths are forward-slashed on both branches (git's own format), so
 * the fuzzy filter sees one alphabet whichever branch ran.
 */
export function atFiles(): readonly AtItem[] {
	let paths: string[];
	try {
		paths = execFileSync("git", ["ls-files", "-c", "-o", "--exclude-standard"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 24 }).split("\n").filter((p) => p !== "");
	} catch {
		paths = atWalk(process.cwd(), "", []);
	}
	return paths.slice(0, AT_CAP + 1).map((path) => ({ path }));
}

/** The fallback walk. `prefix` carries the repo-relative directory so
 *  the result needs no path arithmetic afterwards. An unreadable
 *  directory contributes nothing and ends nothing — the recursion's own
 *  try catches it at that level, so one locked subtree cannot stop a
 *  file picker from opening. */
function atWalk(dir: string, prefix: string, out: string[]): string[] {
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (out.length > AT_CAP) break;
			if (AT_SKIP.has(e.name)) continue;
			if (e.isDirectory()) atWalk(`${dir}/${e.name}`, `${prefix}${e.name}/`, out);
			else if (e.isFile()) out.push(`${prefix}${e.name}`);
		}
	} catch {
		// unreadable — skipped
	}
	return out;
}

/**
 * v2c — the interactive input source. TTYs use the raw-mode Editor (the
 * self-drawn input row — width-aware, the CJK-drift root cause retired,
 * editor.ts); everything else keeps readline exactly as v2b (pipe bytes
 * unchanged). ask()/chat()/resume() talk to this, never to a concrete
 * source.
 */
export interface LineInput {
	onLine(cb: (line: string) => void): void;
	onSigint(cb: () => void): void;
	onEot(cb: () => void): void;
	onEscape(cb: () => void): void;
	/** W15: the expand key (ctrl+r) — the chain-level action, never the
	 *  editor's own interpretation. */
	onExpand(cb: () => void): void;
	/** KC2 §2: the redirect gesture (Alt+Enter / Ctrl+Enter) — the
	 *  buffer's text arrives as a line at the same instant the run is told
	 *  to stop. OPTIONAL: the pipe path has no raw keys and never wires
	 *  it, so readline stays exactly as it was. */
	onRedirect?(cb: (line: string) => void): void;
	question(query: string, cb: (answer: string) => void): void;
	cancelQuestion(): void;
	/** W21: open the approval panel — the editor's state machine takes
	 *  the keys (the digits/y/n/tab/esc/enter routing, the rule input,
	 *  the tab-amend), the compositor renders the block + the leads. */
	panelAsk(view: PanelView, onCommit: (v: PanelVerdict) => void): void;
	/** W21: cancel the panel — the SIGINT pair to panelAsk. */
	panelCancel(): void;
	/** W22: bind the pending-turn queue — the ↑ pop walks the CLI's
	 *  live slots (each pop cancels the turn), esc ends the walk after
	 *  one more pop. The chips are the compositor's own bindQueue. */
	bindQueue(state: () => readonly string[], pop: () => string | null): void;
	emitLine(line: string): void;
	line(): string;
	clearLine(): void;
	prompt(): void;
	close(): void;
	readonly closed: Promise<void>;
}

/** v2b: the bottom-anchored UI — docked only on a color TTY; pipes and
 *  NO_COLOR stay the v2a line mode byte-for-byte. Created at load, like
 *  the pre-split module-scope const. */
export const dock = new Dock();

/** v2d: the body renderer — the ONE writer of the stdout scroll region
 *  (the frozen area + the active tail). Pipes run it in passthrough (the
 *  v2b/v2c line-mode bytes, byte-for-byte). Created in main; closed on
 *  every exit path. */
export let body: Body;
export function setBody(value: Body): void {
	body = value;
}

/** v2d: body output routes through the cell renderer — the single writer.
 *  bodyLog adds the trailing newline; internal newlines are preserved. */
export function bodyLog(text: string): void {
	body.raw(text.split("\n"));
}

/** The model name for the status bar — set by makeAgent. */
export let agentModel = "faux";
export function setAgentModel(value: string): void {
	agentModel = value;
}

/** merge round B: whether the agent runs on the faux provider (no real key) —
 *  set inside makeAgent, read by main for chat/resume's exhaustion check. */
export let currentFaux = true;
export function setCurrentFaux(value: boolean): void {
	currentFaux = value;
}

/** merge round B: the merged config (user + trusted project) as resolved by the
 *  LAST makeAgent — /model and autoCompact resolve against it. */
export let mergedConfig: import("./config.js").KisoConfig = {};
export function setMergedConfig(value: import("./config.js").KisoConfig): void {
	mergedConfig = value;
}

/** merge round B: the resolved context window (env > config.contextWindow) —
 *  chat.ts's contextWindowTokens() consults it before the env. */
export let configuredWindow: number | undefined;
export function setConfiguredWindow(value: number | undefined): void {
	configuredWindow = value;
}

/** merge round B: the merged config (user + trusted project) + the current
 *  model's NAME — /model lists and switches against them. */
export let configModels: Readonly<Record<string, import("./config.js").ModelProfile>> = {};
export function setConfigModels(models: Readonly<Record<string, import("./config.js").ModelProfile>>): void {
	configModels = models;
}
/** The name of the model currently driving the session ("faux" or the
 *  profile name / provider/model write / env model). */
export let currentModelName = "faux";
export function setCurrentModelName(value: string): void {
	currentModelName = value;
}

/** E1: the extensions loaded by makeAgent — their names feed the banner. */
export let loadedExtensions: readonly KisoExtension[] = [];
/** R-D 0.1.45: the BUILT-IN layer — the three default official extensions,
 *  shipped with the cli (module imports, never a disk scan; builtin.ts).
 *  E5: the task extension is opt-in, not built-in. The banner's marked
 *  column; a user extension may shadow a built-in. */
export let builtInExtensions: readonly KisoExtension[] = [];
/** E1: the USER-level extensions alone — the banner's unmarked part (E3:
 *  loadedExtensions later includes the project-level ones too). */
export let userExtensions: readonly KisoExtension[] = [];
/** E3: the PROJECT-level extensions (loaded after the trust gate) — the
 *  banner distinguishes them from the user-level ones. */
export let projectExtensions: readonly KisoExtension[] = [];
export function setExtensionLists(
	builtIn: readonly KisoExtension[],
	user: readonly KisoExtension[],
	project: readonly KisoExtension[],
	loaded: readonly KisoExtension[],
): void {
	builtInExtensions = builtIn;
	userExtensions = user;
	projectExtensions = project;
	loadedExtensions = loaded;
}

/** W21: the CURRENT agent's extensions array — set by makeAgent, the
 *  don't-ask-again writer pushes the generated extension into it so a
 *  first-time rule joins the chain at the NEXT run (the run's policies
 *  are fixed at its start; the array is shared by reference with the
 *  runtime's session config — run.ts re-reads it per run). */
export let currentAgentExtensions: KisoExtension[] = [];
export function setCurrentAgentExtensions(value: KisoExtension[]): void {
	currentAgentExtensions = value;
}

/** E3: temp artifacts of the mcp/skills merge — removed on exit. */
export const mergedTempPaths: string[] = [];

/** The CLI's own version — read from the package.json next to the build. */
export const VERSION = ((): string => {
	try {
		const pkg = JSON.parse(
			readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
		) as { version?: string };
		return pkg.version ?? "?";
	} catch {
		// a packed CLI without a readable package.json still works
		return "?";
	}
})();

/** round 10: a question cancelled by Ctrl+C — NEVER the empty string, which is a
 *  real user answer (the empty line). The empty answer and the cancellation
 *  are distinct facts. */
export const CANCELLED = Symbol("kiso-question-cancelled");
