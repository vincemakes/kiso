/**
 * 手感批 B4 — the CLI's shared process state. The module split (dispatch/
 * chat/resume/trust-ui/faux-glue) is a PURE MOVE: every piece that more
 * than one module touches lives here as a live ESM binding. index.ts
 * creates the mutable ones (setBody / setAgentModel / setExtensionLists);
 * the moved modules read and mutate at call time.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Dock, type Body } from "@vincemakes/kiso-tui";
import type { KisoExtension } from "@vincemakes/kiso-runtime";

/** 发现#11: KISO_HOME is the ONE root — every default path derives from
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
	question(query: string, cb: (answer: string) => void): void;
	cancelQuestion(): void;
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

/** E1: the extensions loaded by makeAgent — their names feed the banner. */
export let loadedExtensions: readonly KisoExtension[] = [];
/** E1: the USER-level extensions alone — the banner's unmarked part (E3:
 *  loadedExtensions later includes the project-level ones too). */
export let userExtensions: readonly KisoExtension[] = [];
/** E3: the PROJECT-level extensions (loaded after the trust gate) — the
 *  banner distinguishes them from the user-level ones. */
export let projectExtensions: readonly KisoExtension[] = [];
export function setExtensionLists(
	user: readonly KisoExtension[],
	project: readonly KisoExtension[],
	loaded: readonly KisoExtension[],
): void {
	userExtensions = user;
	projectExtensions = project;
	loadedExtensions = loaded;
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

/** 十: a question cancelled by Ctrl+C — NEVER the empty string, which is a
 *  real user answer (the empty line). The empty answer and the cancellation
 *  are distinct facts. */
export const CANCELLED = Symbol("kiso-question-cancelled");
