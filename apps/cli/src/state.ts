/**
 * The ergonomics batch B4 — the CLI's shared process state. The module split (dispatch/
 * chat/resume/trust-ui/faux-glue) is a PURE MOVE: every piece that more
 * than one module touches lives here as a live ESM binding. index.ts
 * creates the mutable ones (setBody / setAgentModel / setExtensionLists);
 * the moved modules read and mutate at call time.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AT_CAP, AT_SKIP, Dock, type AtItem, type Body, type PanelVerdict, type PanelView, type SaferAnswer, type SessionCardView } from "@vincemakes/kiso-tui";
import type { TaskDeliveryItem } from "@vincemakes/kiso-core";
import type { KisoExtension, StoreRecord } from "@vincemakes/kiso-runtime";
import { TaskManager } from "@vincemakes/kiso-runtime/internal";
import { processTaskBackend, type ShellTasks } from "@vincemakes/kiso-tools-node";
import { canonicalPath, LEGACY_SESSIONS_DIR, projectDirFor, projectLayoutActive } from "./projects.js";
import { taskNoticeLines, taskWhat } from "./task-notice.js";
import { cliWaitDrivers } from "./wait-drivers.js";

/** finding #11: KISO_HOME is the ONE root — every default path derives from
 *  it (sessions, trust, extensions, mcp config, skills). The dedicated
 *  env vars (KISO_EXTENSIONS_DIR / KISO_MCP_CONFIG / KISO_SKILLS_DIR)
 *  still override their own path; nothing hard-codes ~/.kiso anymore. */
export function kisoHome(): string {
	return process.env.KISO_HOME ?? join(homedir(), ".kiso");
}

/** DC-49 — the workspace the coding tools may touch, and the one place it
 *  is decided. The session's own tool set and the `!` command's runner both
 *  need it, and two copies of a ruling-bearing literal is how a later DC-49
 *  amendment reaches one caller and not the other. */
/**
 * Astra F7 — every configured profile's `apiKeyEnv` NAME is a secret name.
 * The strip's suffix rules cannot see `REVIEW_PROVIDER_TOKEN`, and only the
 * config knows which names are keys, so the config says so. ONE derivation:
 * the shell tool reads it through codingToolOptions, and startup reads it
 * directly for the mcp extension, which spawns its stdio children before
 * these state setters have run.
 */
export function secretEnvNamesOf(models: Readonly<Record<string, unknown>>): readonly string[] {
	return [
		...new Set(
			Object.values(models)
				.map((p) => (p as { readonly apiKeyEnv?: string }).apiKeyEnv)
				.filter((n): n is string => typeof n === "string" && n.length > 0),
		),
	];
}

export function codingToolOptions(): {
	readonly workspaceRoot: string;
	readonly excludeRoots: readonly string[];
	readonly secretEnvNames: readonly string[];
	readonly protectedFiles: readonly string[];
	readonly tasks: (sessionId: string | undefined) => ShellTasks | undefined;
} {
	return { workspaceRoot: process.cwd(), excludeRoots: [kisoHome()], secretEnvNames: secretEnvNamesOf(configModels), protectedFiles: protectedFiles(), tasks: tasksFor };
}

/** ADR-0058 (3b): one TaskManager per session, its directory beside the
 *  session's log (`<store dir>/<session>.tasks/`). A call without a session
 *  — the `!` gesture — has none, and its shell is today's. */
const taskManagers = new Map<string, TaskManager>();
let taskBackend: ReturnType<typeof processTaskBackend> | undefined;
/** Amendment 8: what a session's task ran — a lost task's transcript row
 *  names it. Undefined when the task or its journal cannot be read. */
export function taskWhatOf(sessionId: string | undefined): (taskId: string) => string | undefined {
	return (taskId) => {
		try {
			const t = tasksFor(sessionId)?.get(taskId);
			return t === undefined ? undefined : taskWhat(t);
		} catch {
			return undefined; // a corrupt journal is reported where it is read on purpose
		}
	};
}

/** Amendment 8: the lost tasks this process has told the person of, per
 *  session — when the model's notice of the same loss arrives later, its
 *  row is not said again. */
const toldLost = new Map<string, Set<string>>();
export function lostToldOf(sessionId: string): Set<string> {
	let told = toldLost.get(sessionId);
	if (told === undefined) toldLost.set(sessionId, (told = new Set()));
	return told;
}

/** The transcript lines a delivery shows: a loss already told is left out. */
export function deliveryLines(sessionId: string, items: readonly TaskDeliveryItem[]): string[] {
	const told = lostToldOf(sessionId);
	return taskNoticeLines(
		items.filter((i) => !(i.transition === "unknown" && told.has(i.taskId))),
		taskWhatOf(sessionId),
	);
}

export function tasksFor(sessionId: string | undefined): TaskManager | undefined {
	if (sessionId === undefined || activeStoreDir === "") return undefined;
	let manager = taskManagers.get(sessionId);
	if (manager === undefined) {
		taskBackend ??= processTaskBackend();
		// ADR-0059: the CLI's wait drivers (GitHub over `gh`) ride the manager;
		// `timer` and `task` are the runtime's own
		// KISO_GH_POLL_MS — the test rigs' and the bench's knob (like
		// KISO_STREAM_IDLE_MS): how often the GitHub drivers ask `gh`
		const pollFromEnv = Number.parseInt(process.env.KISO_GH_POLL_MS ?? "", 10);
		manager = new TaskManager({
			root: join(activeStoreDir, `${sessionId}.tasks`),
			backend: taskBackend,
			drivers: cliWaitDrivers({ cwd: () => workspaceRoot(), ...(Number.isFinite(pollFromEnv) && pollFromEnv > 0 ? { pollMs: pollFromEnv } : {}) }),
		});
		manager.observe();
		taskManagers.set(sessionId, manager);
	}
	return manager;
}

/** 3e: what the exit does with the tasks — the exit question's answer.
 *  "leave": a runner's task keeps running (the reopened session hears how
 *  it ends); a moved command is owned by this process and is stopped. */
let exitTasks: "stop" | "leave" = "stop";
export function setExitTasks(choice: "stop" | "leave"): void {
	exitTasks = choice;
}

/** 3e: the live tasks of every session this process opened — a runner's
 *  (`durable`, it survives this process) and moved commands (`moved`). */
export function liveTasks(): { readonly durable: number; readonly moved: number } {
	let durable = 0;
	let moved = 0;
	for (const manager of taskManagers.values()) {
		let list: ReturnType<TaskManager["list"]> = [];
		try {
			list = manager.list();
		} catch {
			continue; // a corrupt journal is reported where it is read on purpose
		}
		for (const t of list) {
			if (t.state.kind !== "running" && t.state.kind !== "starting") continue;
			if (t.backend === "foreground") moved += 1;
			else durable += 1;
		}
	}
	return { durable, moved };
}

/** A clean exit stops the session's tasks — all of them, or (the exit
 *  question's "leave") only the moved commands — and waits for their
 *  terminals. It returns what it could NOT confirm stopped, and what it
 *  left running: a stop requested is never reported as a stop (3e). */
export async function stopAllTasks(): Promise<{ readonly unconfirmed: readonly string[]; readonly left: readonly string[] }> {
	const unconfirmed: string[] = [];
	const left: string[] = [];
	const many = taskManagers.size > 1;
	await Promise.all(
		[...taskManagers].map(async ([sessionId, manager]) => {
			const name = (id: string): string => (many ? `${sessionId}/${id}` : id);
			if (exitTasks === "leave") {
				try {
					for (const t of manager.list()) if (t.backend === "process" && (t.state.kind === "running" || t.state.kind === "starting")) left.push(name(t.id));
				} catch {
					// a corrupt journal: nothing to report as left
				}
			}
			for (const id of await manager.stopAll("exit", 8_000, exitTasks === "leave" ? "moved" : "all")) unconfirmed.push(name(id));
			manager.close();
		}),
	);
	return { unconfirmed, left };
}

/** The user config's `protectedPaths`, as read at the agent's build (and
 *  again at /reload) — `~/` taken against the home directory. */
let userProtectedPaths: readonly string[] = [];
export function setUserProtectedPaths(paths: readonly string[] | undefined): void {
	userProtectedPaths = (paths ?? []).map((p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p));
}

/** kiso never serves its own credential store to a model. The store is
 *  `auth.json` under KISO_HOME — the path auth/credentials.ts writes (a
 *  test holds the two together); its temp file and lock are covered by
 *  the match rule (tools-node protected.ts). Then the user's own list.
 *  ONE list for every reader: the file tools, the search, the shell
 *  check and the `!` gesture. */
export function protectedFiles(): readonly string[] {
	return [join(kisoHome(), "auth.json"), ...userProtectedPaths];
}

/** 0.40.0 — the workspace a session records: the realpath of where kiso
 *  runs, so `/a/link` and `/a/target` are one workspace (and one folder). */
export function workspaceRoot(): string {
	try {
		return realpathSync(process.cwd());
	} catch {
		return process.cwd();
	}
}

/** 0.40.0 — the project a session folder belongs to: the cwd as the disk
 *  spells it (projects.ts canonicalPath). Only the folder's identity uses
 *  it; the tools keep workspaceRoot(). */
export function projectRoot(): string {
	return canonicalPath(process.cwd());
}

let projectSessions: { readonly key: string; readonly dir: string } | null = null;

/**
 * 0.40.0 (the owner's dogfood) — this project's session folder
 * (projects.ts). `KISO_SESSIONS_DIR` pins it (tests, bench runners, a
 * delegated child beside its parent), and a reversed migration restores
 * the single legacy folder.
 *
 * A pure read — the folder is claimed (made, and its workspace recorded)
 * only after the trust gate, where the store is built.
 */
export function ownSessionsDir(): string {
	const pinned = process.env.KISO_SESSIONS_DIR;
	if (pinned !== undefined && pinned !== "") return pinned;
	const home = kisoHome();
	if (!projectLayoutActive(home)) return join(home, LEGACY_SESSIONS_DIR);
	const workspace = projectRoot();
	const key = `${home}\0${workspace}`;
	if (projectSessions?.key !== key) projectSessions = { key, dir: projectDirFor(home, workspace) };
	return projectSessions.dir;
}

let openFolder: string | null = null;

/** 0.40.0 (the lead's ruling) — a session from `_unknown`, or placed in
 *  another project's folder only by inference, resumes WHERE IT IS: a
 *  resume never moves a session. The store is then built on that folder,
 *  and null returns this process to its own. */
export function setOpenSessionFolder(dir: string | null): void {
	openFolder = dir;
}

/** The folder of the session this process has open: its own project's,
 *  or the one an unknown or inferred session was resumed in. */
export function sessionsDir(): string {
	return openFolder ?? ownSessionsDir();
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
		// DC-49: the fallback walk excludes kiso's own state directory.
		paths = atWalk(process.cwd(), "", [], [kisoHome()]);
	}
	return paths.slice(0, AT_CAP + 1).map((path) => ({ path }));
}

/** The fallback walk. `prefix` carries the repo-relative directory so
 *  the result needs no path arithmetic afterwards. An unreadable
 *  directory contributes nothing and ends nothing — the recursion's own
 *  try catches it at that level, so one locked subtree cannot stop a
 *  file picker from opening. */
function atWalk(dir: string, prefix: string, out: string[], excluded: readonly string[] = []): string[] {
	try {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (out.length > AT_CAP) break;
			if (AT_SKIP.has(e.name)) continue;
			const full = `${dir}/${e.name}`;
			if (e.isDirectory()) {
				// DC-49 — the picker does not DESCEND into an excluded root.
				//
				// `AT_SKIP` is a list of NAMES with no dot rule, so unlike
				// tools-node's walk this one has never skipped `~/.kiso` at
				// all: with the workspace at `~` and no git repo there, `@`
				// lists the user's own session logs among their files. That
				// is current behaviour, not a future risk.
				if (excluded.length > 0 && isUnder(full, excluded)) continue;
				atWalk(full, `${prefix}${e.name}/`, out, excluded);
			} else if (e.isFile()) out.push(`${prefix}${e.name}`);
		}
	} catch {
		// unreadable — skipped
	}
	return out;
}

/** DC-49 — realpath on BOTH sides. darwin's `/tmp` is a symlink to
 *  `/private/tmp`, so a raw string compare is a check that passes on one
 *  machine and not another. */
function isUnder(dir: string, roots: readonly string[]): boolean {
	let real: string;
	try {
		real = realpathSync(dir);
	} catch {
		real = dir;
	}
	return roots.some((r) => {
		let rr: string;
		try {
			rr = realpathSync(r);
		} catch {
			rr = r;
		}
		return real === rr || real.startsWith(`${rr}/`);
	});
}

/** DC-49 — the walk, addressable for the gate. `atFiles` is driven by
 *  `process.cwd()` and `kisoHome()`, neither of which a unit case can
 *  set honestly; this is the same function with both supplied. */
export function atWalkFor(root: string, excludeRoots: readonly string[]): readonly string[] {
	return atWalk(root, "", [], excludeRoots);
}

/**
 * v2c — the interactive input source. TTYs use the raw-mode Editor (the
 * self-drawn input row — width-aware, the CJK-drift root cause retired,
 * editor.ts); everything else keeps readline exactly as v2b (pipe bytes
 * unchanged). ask()/chat()/resume() talk to this, never to a concrete
 * source.
 */
export interface LineInput {
	/** CX-1 F5: task-file mode — every line delivered is a TURN, never a
	 *  command; the dispatcher is bypassed (a leading `/` is content). */
	readonly literal?: boolean;
	onLine(cb: (line: string) => void): void;
	onSigint(cb: () => void): void;
	onEot(cb: () => void): void;
	onEscape(cb: () => void): void;
	/** W15: the expand key (ctrl+o) — the chain-level action, never the
	 *  editor's own interpretation. */
	onExpand(cb: () => void): void;
	/** §2.3: the thinking key (ctrl+t) — the same chain-level shape as
	 *  onExpand. Optional: the readline input has no such key, and a
	 *  dock-less session has nothing to reprint. */
	onThink?(cb: () => void): void;
	/** §2.4: the external-editor key (ctrl+g). */
	onEditor?(cb: () => void): void;
	/** ADR-0058 (3e): the background key (ctrl+b). Optional: the readline
	 *  input has no such key — `/tasks` and a steer still reach the tasks. */
	onBackground?(cb: () => void): void;
	/** §2.4: hand the terminal over, run `edit`, take it back. The editor
	 *  owns the handover; the CLI owns the spawn. */
	externalEdit?(edit: (text: string) => string | null): void;
	/** E1 §3: the copy key (ctrl+x) — the chain-level action, never the
	 *  composer's own. The readline input ignores it; `/copy` is the
	 *  route that works everywhere. */
	onCopy(cb: () => void): void;
	/** KC2 §2: the redirect gesture (Alt+Enter / Ctrl+Enter) — the
	 *  buffer's text arrives as a line at the same instant the run is told
	 *  to stop. OPTIONAL: the pipe path has no raw keys and never wires
	 *  it, so readline stays exactly as it was. */
	onRedirect?(cb: (line: string) => void): void;
	/** REL-0152-D11: an empty bracketed paste is the image case — a
	 *  terminal cannot put binary in a byte stream, so pasting one sends
	 *  nothing. The callback returns text to insert (a path) or null.
	 *  Optional: the pipe path has no editor and no clipboard. */
	onClipboardPaste?(cb: () => string | null): void;
	/** REL-0152-D16: which file each `[Image #N]` capsule in the line
	 *  stands for. Optional — the pipe path has no editor. */
	attachments?(): Map<number, string>;
	question(query: string, cb: (answer: string) => void): void;
	cancelQuestion(): void;
	/** W21: open the approval panel — the editor's state machine takes
	 *  the keys (the digits/y/n/tab/esc/enter routing, the rule input,
	 *  the tab-amend), the compositor renders the block + the leads. */
	/** TUI2-R3v2 ③: `opts.safer` is the on-demand alternatives provider —
	 *  absent for every panel that has no such option (the ask, the pick,
	 *  the trust gate), so those buttons cannot exist to be pressed.
	 *  R3v2-F1: it resolves a SaferAnswer, so a failure that can name its
	 *  cause does — `null` still means a failure with nothing to add. */
	panelAsk(view: PanelView, onCommit: (v: PanelVerdict) => void, opts?: { safer?: () => Promise<SaferAnswer> }): void;
	/** Graphite R3e: a read-only sheet over the input with the caller's rows
	 *  (`/status`, `/context`, `/skills`); any key closes it. Absent off a
	 *  dock. */
	openSheet?(rows: (W: number) => string[]): void;
	/** The sheets round: open the command list, as a typed `/` does
	 *  (`/help`). Absent off a dock. */
	openCommands?(): void;
	/** W21: cancel the panel — the SIGINT pair to panelAsk. */
	panelCancel(): void;
	/** TUI2-R2 ②: open the session picker — the editor takes the keys
	 *  (the selection walk, the filter, enter/esc) and hands back the
	 *  picked id, or null when the human leaves without picking.
	 *  OPTIONAL: only the raw-mode editor has it, and the picker only
	 *  ever opens on a TTY (a pipe has nobody to pick). */
	pick?(cards: () => readonly SessionCardView[], onPick: (id: string | null) => void, here?: string): void;
	/** W22: bind the pending-turn queue — the ↑ pop walks the CLI's
	 *  live slots (each pop cancels the turn), esc ends the walk after
	 *  one more pop. The chips are the compositor's own bindQueue. */
	bindQueue(state: () => readonly string[], pop: () => string | null): void;
	/** ADR-0057: put text back into the editor — the steers a stop handed
	 *  back before they landed. The pipe path has no editor; optional. */
	restore?(text: string): void;
	/** R3a: cross-session history — seed the recall buffer, register the
	 *  append sink. The pipe path has no recall keys; optional. */
	bindHistory?(seed: readonly string[], persist: (line: string) => void): void;
	/** R3a: Shift+Tab cycles the approval tier (TTY editor only). */
	onModeCycle?(cb: () => void): void;
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
export function bodyLog(text: string, wrap?: "words"): void {
	body.raw(text.split("\n"), wrap);
}

/** TUI2-R2 ②/③: the session store createCodingAgent built — the ONE store per
 *  process. The navigation surfaces need its read side (load) to project
 *  the badges, and a second store on the same root would be a second
 *  lock manager for a job that never writes. */
export let sessionStoreRef: { load(id: string): readonly StoreRecord[] } | null = null;
export function setSessionStore(value: { load(id: string): readonly StoreRecord[] }): void {
	sessionStoreRef = value;
}

/** The folder createCodingAgent built the store on — written there and by
 *  the resume picker's folder switch, read by the listings. */
export let activeStoreDir = "";

/** ADR-0058 3d (D6): a background child's turn budget (`--max-turns`, with
 *  `--task-file` only) — the agent's maxTurns. Unset everywhere else: the
 *  interactive door has no turn limit (R3e). */
export let childTurnBudget: number | undefined;
export function setChildTurnBudget(n: number | undefined): void {
	childTurnBudget = n;
}
export function setActiveStoreDir(value: string): void {
	activeStoreDir = value;
}

/** The model name for the status bar — set by createCodingAgent. */
export let agentModel = "faux";
/** OR-1: the live model's ENDPOINT, set in the same call as the model so
 *  the two can never drift: the window lookup keys on (model, endpoint). */
export let agentBaseUrl: string | undefined;
export function setAgentModel(value: string, baseUrl?: string): void {
	agentModel = value;
	agentBaseUrl = baseUrl;
}

/** merge round B: whether the agent runs on the faux provider (no real key) —
 *  set inside createCodingAgent, read by main for chat/resume's exhaustion check. */
export let currentFaux = true;
export function setCurrentFaux(value: boolean): void {
	currentFaux = value;
}

/** merge round B: the merged config (user + trusted project) as resolved by the
 *  LAST createCodingAgent — /model and autoCompact resolve against it. */
export let mergedConfig: import("./config.js").KisoConfig = {};
export function setMergedConfig(value: import("./config.js").KisoConfig): void {
	mergedConfig = value;
}

/** ADR-0005 Amendment 2: the retry the kernel announced and is waiting
 *  on, for the running and compacting rows — `until` is the wall-clock
 *  end of the wait. Null when no retry is pending. Cleared by the next
 *  event from the run, which means the attempt got through, and wherever
 *  a run or a compaction starts and ends. */
export interface RetryShown {
	readonly attempt: number;
	readonly maxRetries: number;
	readonly code: string;
	readonly until: number;
}
export let retryShown: RetryShown | null = null;
export function setRetryShown(value: RetryShown | null): void {
	retryShown = value;
}

/** The pending retry as a row shows it, with the time left computed NOW:
 *  the rows repaint on their own timers, so the countdown moves between
 *  the kernel's announcements. */
export function retryOnRow(): import("@vincemakes/kiso-tui").RetryOnRow | null {
	const r = retryShown;
	return r === null ? null : { attempt: r.attempt, maxRetries: r.maxRetries, code: r.code, remainingMs: r.until - Date.now() };
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
/** CW-1: the upstream a forwarder at `baseUrl` names — a fact about the
 *  ADDRESS, so a resumed session (no profile name in hand) finds it too:
 *  the first profile at that address that names one. */
export function upstreamOf(baseUrl: string | undefined): string | undefined {
	if (baseUrl === undefined) return undefined;
	for (const p of Object.values(configModels)) if (p.baseUrl === baseUrl && p.upstream !== undefined) return p.upstream;
	return undefined;
}
/** The name of the model currently driving the session ("faux" or the
 *  profile name / provider/model write / env model). */
/**
 * §2.5 — the profile the human CHOSE by name, and the only source a
 * rebuild may read for the model.
 *
 * Not `currentModelName`: that holds whatever resolution produced, and
 * an env-resolved session's name ("gpt-4o", "claude-sonnet-5") is not a
 * key in `models`, so handing it back to `resolveModel` throws. Not the
 * startup flag either, or a `/model` switch would silently revert on the
 * first reload — the effort-axis round produced that bug once already
 * from having two sources for the model.
 *
 * One variable, seeded by `createCodingAgent` from the startup flag and
 * overwritten by `/model`. Undefined means "resolve exactly as this
 * process did at startup", which is the right answer for a session that
 * never named a profile.
 */
export let modelChoice: string | undefined;
export function setModelChoice(value: string | undefined): void {
	modelChoice = value;
}

export let currentModelName = "faux";
export function setCurrentModelName(value: string): void {
	currentModelName = value;
}

/** REVIEW (2026-09-21): WHO the binding came from is a different fact from
 *  WHICH model it names, and `currentModelName` carried both — a profile alias
 *  after `/model`, a model id after a switch, a resume or a reload. Surfaces
 *  that want to name the PROFILE ask this one; an unknown profile is null, and
 *  nothing guesses a credential identity out of a model name and a host. */
export let currentProfileName: string | null = null;
export function setCurrentProfileName(value: string | null): void {
	currentProfileName = value;
}

/** DC-57 (the owner's ruling, 2026-09-21): lines that arrived with a switch
 *  command — a paste, a pipe, a scripted driver — belong to the session the
 *  person asked for. The departing entry queues them here and the next
 *  `chat()` drains them into its own replay, so no line is answered by the
 *  session being left and none is dropped. */
export const queuedSwitchLines: string[] = [];

/** E1: the extensions loaded by createCodingAgent — their names feed the banner. */
/** 0.40.0: whether the catastrophe floor is on (floor.ts) — the user
 *  config's `floor`, read where the chain is assembled. */
/** 0.40.6: what /settings needs to name each value's layer — the two config
 *  files as read, the command-line flags as given, and whether /model
 *  changed the binding in this session. */
export const settingsLayers: {
	user: import("./config.js").KisoConfig | null;
	project: import("./config.js").KisoConfig | null;
	modeFlag: string | undefined;
	dontAskFlag: boolean;
	modelFlag: string | undefined;
	modelSwitched: boolean;
} = { user: null, project: null, modeFlag: undefined, dontAskFlag: false, modelFlag: undefined, modelSwitched: false };

export let floorOn = true;
export function setFloorOn(value: boolean): void {
	floorOn = value;
}

/** 0.40.0: the calls a saved allow never carries (protected-writes.ts) —
 *  set where the chain is assembled, read where a first grant joins it. */
export let neverInherited: (call: import("@vincemakes/kiso-core").PolicyCall) => boolean = () => false;
export function setNeverInherited(value: (call: import("@vincemakes/kiso-core").PolicyCall) => boolean): void {
	neverInherited = value;
}

export let loadedExtensions: readonly KisoExtension[] = [];
/** R-D 0.1.45: the BUILT-IN layer — the three default official extensions,
 *  shipped with the cli (module imports, never a disk scan; builtin.ts).
 *  The task extension, opt-in from E5, was retired in 0.44.0. The
 *  banner's marked column; a user extension may shadow a built-in. */
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

/** 0.40.0: the skills catalog of the loaded skills extension — the scan the
 *  model's index came from, so `/skill` and `/skills` cannot list a
 *  different set. Null when no skills extension is loaded (or a user
 *  extension named "skills" shadows it and reports none). */
export function loadedSkillsCatalog(): import("@vincemakes/kiso-skills-ext").SkillsCatalog | null {
	const ext = loadedExtensions.find((e) => e.name === "skills") as { catalog?: import("@vincemakes/kiso-skills-ext").SkillsCatalog } | undefined;
	return ext?.catalog ?? null;
}

/** W21: the CURRENT agent's extensions array — set by createCodingAgent, the
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

/** XP-1: the last EXPLICIT model binding this process applied — a
 *  /clear-fresh session inherits it (clearing context never silently
 *  reverts the model). Never persisted here; the runtime records the
 *  durable revision when the binding is applied. */
export interface LastBinding {
	readonly adapter: import("@vincemakes/kiso-core").Adapter;
	readonly model: string;
	readonly provider?: "anthropic" | "openai-compat" | "openai-responses";
	/** OR-1: the endpoint inherits with the adapter (the cost path keys on it). */
	readonly baseUrl?: string;
	readonly scope?: import("@vincemakes/kiso-core").ContinuationScope;
	readonly reasoning?: import("@vincemakes/kiso-runtime/internal").ReasoningSetting;
	/** 0.40.0: the config profile that named the binding (null for a direct
	 *  provider/model) — a /clear-fresh session records it too. */
	readonly profileName?: string | null;
}
let lastBindingValue: LastBinding | null = null;
export function setLastBinding(b: LastBinding): void {
	lastBindingValue = b;
}
export function lastBinding(): LastBinding | null {
	return lastBindingValue;
}

/** XP-1 (the adjudicated Q6): --accept-drift is a per-invocation FLAG,
 *  never an env var — a standing env would be a silent policy, the exact
 *  failure the drift protocol forbids. */
let acceptDriftValue = false;
export function setAcceptDrift(v: boolean): void {
	acceptDriftValue = v;
}
export function acceptDrift(): boolean {
	return acceptDriftValue;
}
