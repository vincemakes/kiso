import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, createAgent, kisoHome, runsACheck, type AgentDefinition, type SessionStore } from "@vincemakes/kiso-runtime";
import { adapterOptionsFor, type AdapterAuth, type ModelProfile } from "@vincemakes/kiso-code/config";
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
 * The model, the sign-in and the effort come from the terminal's own
 * configuration (settings.ts, through the `./config` door). The in-run
 * compaction tiers are on, drawn from the profile's window, with the
 * person's configured `checks` in front of the built-in test runners.
 */

export type ModelChoice =
	| { readonly kind: "adapter"; readonly adapter: Adapter; readonly model: string; readonly route: string }
	| {
			readonly kind: "profile";
			readonly name: string;
			readonly profile: ModelProfile;
			readonly auth: AdapterAuth;
			/** the window the profile or the configuration states; absent: nobody does */
			readonly contextWindow?: number | undefined;
			readonly reasoning?: AgentDefinition["reasoning"];
	  };

/** The adapter identity a model is routed by (what pricing is looked up on). */
export const routeOf = (model: ModelChoice): string => (model.kind === "adapter" ? model.route : model.profile.kind);

const DEFAULT_WINDOW = 200_000;

/** The permission tiers the terminal offers; `default` asks before writes and commands. */
export type PermissionMode = Parameters<typeof setMode>[0];

export interface DesktopAgentOptions {
	readonly store: SessionStore;
	readonly workspace: string;
	readonly model: ModelChoice;
	/** The tier in force for this session, read on every decision: each Work has its own (the policy reads it through the getter). */
	readonly tier: () => PermissionMode;
	/** The id of the session this agent serves (the endpoint's cache key and `{session}` headers are drawn from it). */
	readonly sessionId: string;
	/** The person's own test-runner commands, in front of the built-in ones, for the compaction phase rule. */
	readonly checkRunners?: readonly string[];
	readonly tasks: TaskHub;
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
	const window = model.kind === "profile" ? model.contextWindow : undefined;
	const prompt = composeSystemPrompt(workspace, protectedFiles());
	const modeNote = modeSystemPrompt(options.tier());
	const definition: AgentDefinition = {
		model: model.kind === "adapter" ? model.model : model.profile.model,
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
			...modeExtensions(root, options.tier),
			readOnlyShellExtension(() => ({ workspaceRoot: workspace, excludeRoots: toolOptions.excludeRoots })),
		],
		// in-run compaction, as the terminal turns it on (ADR-0055): only a window someone stated arms the overflow belt
		contextPolicy: {
			tiers: {
				windowTokens: window ?? DEFAULT_WINDOW,
				isCheck: (command: string) => runsACheck(command, options.checkRunners ?? []),
				statedWindow: () => window ?? null,
			},
		},
		...(model.kind === "adapter"
			? { adapter: model.adapter }
			: {
					provider: model.profile.kind,
					...adapterOptionsFor(model.profile, model.auth, options.sessionId),
					...(model.profile.streamIdleMs !== undefined ? { streamIdleMs: model.profile.streamIdleMs } : {}),
					...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
				}),
	};
	return options.onSession === undefined ? createAgent(definition) : new DesktopAgent(definition, options);
}
