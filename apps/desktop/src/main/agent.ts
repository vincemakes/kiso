import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, createAgent, kisoHome, type AgentDefinition, type SessionStore } from "@vincemakes/kiso-runtime";
import type { Adapter } from "@vincemakes/kiso-core";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import {
	CODING_TOOL_RULES,
	breakerExtension,
	composeSystemPrompt,
	floorExtension,
	modeExtensions,
	modeSystemPrompt,
	protectedShellExtension,
	readOnlyShellExtension,
	setMode,
} from "@vincemakes/kiso-code/policy";
import { observedRevisionFrom } from "./observed-revision.js";
import type { TaskHub } from "./tasks.js";

/**
 * The desktop's agent factory: public exports only (runtime root, tools-node
 * root, core, and the terminal product's `./policy` door). The policy door is
 * what keeps this agent from being a second, unguarded one: the coding
 * prompt and tool rules, the catastrophe floor, the protected-file shell
 * guard, the read-only shell allow, the loop breaker and the mode tiers are
 * the terminal's own, in the terminal's own chain order.
 *
 * Not carried yet: config and credential resolution (S2; S1 takes the
 * provider and key from the environment) and the context-compaction tiers.
 */

export type ModelChoice =
	| { readonly kind: "adapter"; readonly adapter: Adapter; readonly model: string; readonly route: string }
	| { readonly kind: "provider"; readonly provider: "anthropic" | "openai-compat" | "openai-responses"; readonly model: string; readonly baseUrl?: string; readonly apiKey: string; readonly reasoning?: AgentDefinition["reasoning"] };

/** The permission tiers the terminal offers; `default` asks before writes and commands. */
export type PermissionMode = Parameters<typeof setMode>[0];

export interface DesktopAgentOptions {
	readonly store: SessionStore;
	readonly workspace: string;
	readonly model: ModelChoice;
	readonly tasks: TaskHub;
	/** The tier; process-wide, as in the terminal (the policy modules keep it as module state). */
	readonly mode: PermissionMode;
	/** Env var names that hold a secret and must not reach a shell child. */
	readonly secretEnvNames?: readonly string[];
	/** The shell's foreground bounds (ADR-0058); the defaults are 60 s and 5 min. */
	readonly toolLimits?: { readonly minForegroundMs?: number; readonly maxForegroundMs?: number };
	/** Called on each new session (the task delivery is wired here). */
	readonly onSession?: (sessionId: string, session: Awaited<ReturnType<Agent["session"]>>) => void;
}

/** The credential store is never served to a model: file tools and shell checks share this list. */
export function protectedFiles(): readonly string[] {
	return [join(kisoHome(), "auth.json")];
}

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

export function createDesktopAgent(options: DesktopAgentOptions): Agent {
	const { store, workspace, model } = options;
	setMode(options.mode);
	const root = (): string => workspace;
	const toolOptions = {
		workspaceRoot: workspace,
		excludeRoots: [kisoHome()],
		secretEnvNames: options.secretEnvNames ?? [],
		protectedFiles: protectedFiles(),
		tasks: options.tasks.shellTasks,
		observedRevision: observedRevisionFrom(store, workspace),
		...(options.toolLimits !== undefined ? { limits: options.toolLimits } : {}),
	};
	const prompt = composeSystemPrompt(workspace, protectedFiles());
	const modeNote = modeSystemPrompt();
	const definition: AgentDefinition = {
		model: model.model,
		store,
		workspace,
		systemPrompt: modeNote === undefined ? prompt : `${prompt}\n\n${modeNote}`,
		toolRules: CODING_TOOL_RULES,
		tools: [...createCodingTools(toolOptions)],
		// the terminal's chain, in its order: the guards that deny speak first
		extensions: [
			protectedShellExtension({ files: protectedFiles, workspaceRoot: root, env: () => ({ home: homedir(), kisoHome: kisoHome() }) }),
			floorExtension(() => true, root),
			breakerExtension(),
			...modeExtensions(root),
			readOnlyShellExtension(() => ({ workspaceRoot: workspace, excludeRoots: toolOptions.excludeRoots })),
		],
		...(model.kind === "adapter"
			? { adapter: model.adapter }
			: { provider: model.provider, apiKey: model.apiKey, ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}), ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}) }),
	};
	return options.onSession === undefined ? createAgent(definition) : new DesktopAgent(definition, options);
}
