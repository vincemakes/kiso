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
	/** 0.49.0 B: live writers (implementer, verifier) per session (default 4). */
	readonly writerMax?: number;
	/** 0.49.0 B: a writer's model requests before its wrap-up (default 128;
	 *  a writer also keeps its wall clock). */
	readonly writerMaxTurns?: number;
	/** 0.49.0 B: the most a writer's working-tree snapshot may copy (default
	 *  50 MiB); over it the delegation is refused, never run from HEAD. */
	readonly snapshotMaxBytes?: number;
}

/** 0.49.0 B: collect a writer whose process ended — its patch, the
 *  versions it changed, the child's acceptance, a verifier behind it — and
 *  record `collected`, last. The host's TaskManager calls it (its `collect`
 *  option) with the manager that starts a verifier behind it. */
export function collectWriter(
	info: { readonly id: string; readonly outputPath: string; readonly executionId?: string; readonly stoppedBy?: string; readonly agent?: { readonly role: string; readonly session: string } },
	manager: SubagentTasks,
): Promise<void>;

export interface SubagentBinding {
	readonly profile: string | null;
	readonly model?: string;
	readonly reasoning?: { readonly thinking: string; readonly effort: string };
}

declare const createSubagentExtension: (host?: SubagentHost) => KisoExtension | Promise<KisoExtension>;
export default createSubagentExtension;

/** 0.49.0 B6.1: a writer's private workspace — the person's working tree
 *  at dispatch (uncommitted edits and untracked files, never ignored ones)
 *  in a task-private repository that borrows the person's objects
 *  read-only; nothing is written into the person's repository. Throws a
 *  refusal over `maxBytes`, or when the tree would not hold still. */
export function snapshotWorkspace(parentCwd: string, ws: string, maxBytes?: number): { readonly root: string; readonly head: string; readonly base: string; readonly cwd: string; readonly sub: string };
