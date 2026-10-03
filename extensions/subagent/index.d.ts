/**
 * The published type surface of @vincemakes/kiso-subagent-ext: the
 * default export is the FACTORY (the same contract the user-layer disk
 * loader accepts — a KisoExtension or a factory returning one). The type
 * import from kiso-core is compile-time only — the shipped bundle is
 * self-contained, zero runtime dependencies.
 */
import type { KisoExtension } from "@vincemakes/kiso-core";

/** ADR-0058 3d: what a background delegation needs of the host's per-session
 *  task manager — the runtime's TaskManager satisfies it structurally. */
export interface SubagentTasks {
	list(): readonly { readonly agent?: unknown; readonly state: { readonly kind: string } }[];
	start(options: {
		readonly command: string;
		readonly cwd: string;
		readonly env?: Readonly<Record<string, string | undefined>>;
		readonly executionId?: string;
		readonly agent: { readonly role: string; readonly session: string };
		readonly exec: (dir: string) => { readonly file: string; readonly args: readonly string[] };
	}): Promise<{ readonly id: string }>;
}

export interface SubagentHost {
	/** The session's task manager; with it, `delegate` offers `background`. */
	readonly tasks?: (sessionId: string | undefined) => SubagentTasks | undefined;
	/** Live background children per session (default 20). */
	readonly backgroundMax?: number;
	/** A background child's model requests before its wrap-up (default 32). */
	readonly backgroundMaxTurns?: number;
}

declare const createSubagentExtension: (host?: SubagentHost) => KisoExtension | Promise<KisoExtension>;
export default createSubagentExtension;
