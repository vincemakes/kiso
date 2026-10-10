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
	/** 0.49.0 A: the join waits for its children and claims what ended
	 *  (`agentJoin`); the person's key and a steer reach it as a detach. */
	awaitSettled(
		id: string,
		until: "end" | "ready",
		ms: number,
		opts?: { readonly executionId?: string; readonly signal?: AbortSignal; readonly agentJoin?: boolean },
	): Promise<{ readonly info: { readonly outputPath: string; readonly state: { readonly kind: string; readonly exitCode?: number | null } }; readonly settled: boolean; readonly claimed: boolean }>;
	registerDetachable?(executionId: string, detachable: { readonly startedAt: number; detach(by: "person" | "steer"): void }): () => void;
}

export interface SubagentHost {
	/** The session's task manager; with it, `delegate` offers `background`. */
	readonly tasks?: (sessionId: string | undefined) => SubagentTasks | undefined;
	/** Live background children per session (default 20). */
	readonly backgroundMax?: number;
	/** A reader child's model requests before its wrap-up (default 32) —
	 *  in the background, and (0.49.0) in the foreground too. */
	readonly backgroundMaxTurns?: number;
	/** 0.49.0: the conversation's live binding — the configured profile its
	 *  session is bound to (null when none can be named) and the effort it
	 *  runs at. A child whose task names no model, with no subagents.model
	 *  configured, runs on this profile at this effort. */
	readonly currentBinding?: (sessionId: string | undefined) => SubagentBinding | null;
	/** 0.49.0 A: how long a foreground reader delegation waits for its
	 *  children before they continue as a background group (default 60000,
	 *  the shell's foreground wait). Nothing is killed when it passes. */
	readonly joinMs?: number;
}

export interface SubagentBinding {
	readonly profile: string | null;
	readonly model?: string;
	readonly reasoning?: { readonly thinking: string; readonly effort: string };
}

declare const createSubagentExtension: (host?: SubagentHost) => KisoExtension | Promise<KisoExtension>;
export default createSubagentExtension;
