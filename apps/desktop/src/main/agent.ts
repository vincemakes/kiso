import { Agent, createAgent, type AgentDefinition, type PermissionPolicy, type SessionStore } from "@vincemakes/kiso-runtime";
import type { Adapter } from "@vincemakes/kiso-core";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { observedRevisionFrom } from "./observed-revision.js";
import type { TaskHub } from "./tasks.js";

/**
 * The desktop's agent factory — PUBLIC exports only (runtime root,
 * tools-node root, core). What the terminal product adds on top and keeps
 * behind its own door: the coding prompt and tool rules, the floor and
 * protected-shell extensions, the mode tiers, the read-only-shell allow,
 * config and credential resolution, the observed-revision log reader. The
 * spike runs without them and says so in its report.
 */

export type ModelChoice =
	| { readonly kind: "adapter"; readonly adapter: Adapter; readonly model: string; readonly route: string }
	| { readonly kind: "provider"; readonly provider: "anthropic" | "openai-compat" | "openai-responses"; readonly model: string; readonly baseUrl?: string; readonly apiKey: string; readonly reasoning?: AgentDefinition["reasoning"] };

export interface DesktopAgentOptions {
	readonly store: SessionStore;
	readonly workspace: string;
	readonly model: ModelChoice;
	readonly tasks: TaskHub;
	/** The shell's foreground bounds (ADR-0058); the defaults are 60 s and 5 min. */
	readonly toolLimits?: { readonly minForegroundMs?: number; readonly maxForegroundMs?: number };
	/** Called on each new session (the task delivery is wired here). */
	readonly onSession?: (sessionId: string, session: Awaited<ReturnType<Agent["session"]>>) => void;
}

/** Reads and the safe tools run; edits, writes and shell ask the person. */
export const ASK_BEFORE_WRITES: PermissionPolicy = {
	rules: [
		{ tool: "read_file", action: "allow" },
		{ tool: "list_dir", action: "allow" },
		{ tool: "search_text", action: "allow" },
		{ tool: "task_stop", action: "allow" },
		{ tool: "write_file", action: "defer" },
		{ tool: "edit_file", action: "defer" },
		{ tool: "shell", action: "defer" },
	],
	default: "deny",
};

export const ALLOW_ALL: PermissionPolicy = { rules: [], default: "allow" };

export const SYSTEM_PROMPT = "You are a coding assistant in the user's workspace. Use the tools to act; be concise.";

/** The agent subclass the service opens per session: it binds the session's
 *  task delivery after the runtime creates the session — the service gives
 *  a host no other hook on the Session object. */
class DesktopAgent extends Agent {
	readonly #options: DesktopAgentOptions;
	constructor(definition: AgentDefinition, options: DesktopAgentOptions) {
		super(definition);
		this.#options = options;
	}
	override async session(options: { id: string; acceptDrift?: boolean }) {
		const session = await super.session(options);
		this.#options.onSession?.(options.id, session);
		return session;
	}
}

export function createDesktopAgent(options: DesktopAgentOptions, policy: PermissionPolicy = ASK_BEFORE_WRITES): Agent {
	const { store, workspace, model } = options;
	const definition: AgentDefinition = {
		model: model.model,
		store,
		workspace,
		systemPrompt: SYSTEM_PROMPT,
		tools: [...createCodingTools({ workspaceRoot: workspace, excludeRoots: [], tasks: options.tasks.shellTasks, observedRevision: observedRevisionFrom(store, workspace), ...(options.toolLimits !== undefined ? { limits: options.toolLimits } : {}) })],
		permissionPolicy: policy,
		...(model.kind === "adapter"
			? { adapter: model.adapter }
			: { provider: model.provider, apiKey: model.apiKey, ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}), ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}) }),
	};
	return options.onSession === undefined ? createAgent(definition) : new DesktopAgent(definition, options);
}
