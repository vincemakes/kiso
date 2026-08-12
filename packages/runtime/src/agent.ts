/**
 * AgentRuntime + createAgent — the high-level entry point (Phase C).
 *
 *   const agent = createAgent({ model, systemPrompt, tools, store,
 *                              permissionPolicy, provider });
 *   const session = await agent.session({ id: "demo" });
 *   for await (const event of session.run("Inspect this repository")) { }
 *
 * The runtime is provider-agnostic: an adapter may be injected directly, or
 * a provider name triggers a lazy import of the matching @kiso provider
 * package (optional peers — an unused provider costs nothing). The kernel
 * itself stays dependency-free; the SDKs live in the provider packages.
 */

import { EventLog, ToolRegistry, type Adapter, type HookHost, type KisoExtension, type Tool } from "@vincemakes/kiso-core";
import { AgentSession, type SessionConfig } from "./session.js";
import type { SessionStore } from "./store.js";

export interface PermissionRule {
	readonly tool: string;
	readonly action: "allow" | "deny" | "defer";
}

export interface PermissionPolicy {
	/** First matching rule wins. */
	readonly rules: readonly PermissionRule[];
	/** Default for tools without a rule — deny is the safe default. */
	readonly default?: "allow" | "deny" | "defer";
}

export interface AgentDefinition {
	readonly model: string;
	readonly systemPrompt?: string;
	/** `Tool<any>` like the registry: typed tools register without casts. */
	readonly tools: readonly Tool<any>[];
	readonly store: SessionStore;
	readonly permissionPolicy?: PermissionPolicy;
	/** Raw loop hooks (observers, custom permission logic). */
	readonly hooks?: HookHost;
	/** Direct adapter injection (tests, faux, custom providers). */
	readonly adapter?: Adapter;
	/** Lazy provider: "anthropic" | "openai-compat" (imports the peer package). */
	readonly provider?: "anthropic" | "openai-compat";
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly maxTurns?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	/**
	 * DEPRECATED (ADR-0044): the classic auto-compaction path is retired —
	 * the loop ignores this (microcompact absorbed the responsibility; old
	 * sessions' `compacted` events still replay). Kept so old definitions
	 * type-check; removed at 1.0.
	 */
	readonly compaction?: { readonly thresholdTokens: number };
	/** C area: microcompact threshold — passed through to every session. */
	readonly microcompact?: { readonly thresholdTokens: number };
	readonly maxRetries?: number;
	/** E1: loaded extensions — their tools merge into the registry (a name
	 *  collision with a built-in is a loud startup error), their hooks
	 *  compose after the agent's own (the existing come first), their approvals join the
	 *  loop's policy chain. */
	readonly extensions?: readonly KisoExtension[];
}

/** @deprecated the canonical name is `Agent` (root export, 1.1.0); this alias is removed in the next major. */
export class AgentRuntime {
	readonly #definition: AgentDefinition;
	readonly #registry: ToolRegistry;
	readonly #adapterPromise: Promise<Adapter>;

	constructor(definition: AgentDefinition) {
		this.#definition = definition;
		this.#registry = new ToolRegistry();
		for (const tool of definition.tools) this.#registry.register(tool);
		// E1: extension tools join the registry — a collision with a built-in
		// name throws here, at agent creation: a loud startup failure.
		for (const ext of definition.extensions ?? []) {
			for (const tool of ext.tools ?? []) this.#registry.register(tool);
			// 0.1.26 (MCP lazy connection): an extension's tools array is LIVE — the
			// registry consults it on every lookup, so tools registered by a
			// background connect (the MCP bridge's servers) are callable the
			// moment they land, without a session rebuild.
			this.#registry.registerLive(() => ext.tools ?? []);
		}
		this.#adapterPromise = resolveAdapter(definition);
	}

	sessionIds(): string[] {
		return this.#definition.store.list().map((m) => m.id);
	}

	/** Session metadata for listings (`kiso sessions`). */
	sessions() {
		return this.#definition.store.list();
	}

	/** Release every held fd and writer lock (E group: the CLI closes on exit). */
	close(): void {
		this.#definition.store.closeAll();
	}

	/** Load an existing session from disk, or create a fresh one. */
	async session(options: { id: string }): Promise<AgentSession> {
		const store = this.#definition.store;
		const records = store.load(options.id);
		const log = new EventLog(records.map((r) => r.event));
		const adapter = await this.#adapterPromise;
		const config: SessionConfig = {
			model: this.#definition.model,
			...(this.#definition.provider !== undefined ? { provider: this.#definition.provider } : {}),
			...(this.#definition.systemPrompt !== undefined ? { systemPrompt: this.#definition.systemPrompt } : {}),
			registry: this.#registry,
			...(this.#definition.permissionPolicy !== undefined || this.#definition.hooks !== undefined
				? {
						hooks: {
							...this.#definition.hooks,
							...(this.#definition.permissionPolicy !== undefined ? policyHooks(this.#definition.permissionPolicy) : {}),
						},
					}
				: {}),
			...(this.#definition.maxTurns !== undefined ? { maxTurns: this.#definition.maxTurns } : {}),
			...(this.#definition.maxTokens !== undefined ? { maxTokens: this.#definition.maxTokens } : {}),
			...(this.#definition.temperature !== undefined ? { temperature: this.#definition.temperature } : {}),
			...(this.#definition.compaction !== undefined ? { compaction: this.#definition.compaction } : {}),
			...(this.#definition.microcompact !== undefined ? { microcompact: this.#definition.microcompact } : {}),
			...(this.#definition.maxRetries !== undefined ? { maxRetries: this.#definition.maxRetries } : {}),
			...(this.#definition.extensions !== undefined ? { extensions: this.#definition.extensions } : {}),
		};
		return new AgentSession(options.id, log, store, adapter, config);
	}
}

/** The one-liner the README promises. */
export function createAgent(definition: AgentDefinition): AgentRuntime {
	return new AgentRuntime(definition);
}

/** Wire a PermissionPolicy into the loop's onPreTool hook. */
function policyHooks(policy: PermissionPolicy): HookHost {
	return {
		onPreTool: async (call) => {
			for (const rule of policy.rules) {
				if (rule.tool === call.name) {
					return rule.action === "allow"
						? { action: "allow" }
						: rule.action === "deny"
							? { action: "deny", reason: `denied by policy rule for ${call.name}` }
							: { action: "defer" };
				}
			}
			switch (policy.default ?? "deny") {
				case "allow":
					return { action: "allow" };
				case "defer":
					return { action: "defer" };
				default:
					return { action: "deny", reason: `no policy rule for ${call.name} (default deny)` };
			}
		},
	};
}

/**
 * merge round B: the adapter factory the CLI uses for /model switches — the
 * same lazy provider resolution as createAgent's (the CLI never imports
 * provider SDKs directly; the runtime owns them here). Returns a NEW
 * adapter each call; the caller (session.setAdapter) decides when it
 * takes effect.
 */
export async function buildAdapter(
	provider: "anthropic" | "openai-compat",
	opts: { readonly apiKey?: string; readonly baseUrl?: string } = {},
): Promise<Adapter> {
	// resolveAdapter consumes only provider/apiKey/baseUrl from the
	// definition — the rest is irrelevant for a bare adapter build.
	return resolveAdapter({ provider, ...opts } as AgentDefinition);
}

async function resolveAdapter(definition: AgentDefinition): Promise<Adapter> {
	if (definition.adapter) return definition.adapter;
	switch (definition.provider) {
		// round 7: the runtime imports ONLY the provider package — its high-level
		// factory owns the SDK and builds the adapter from config. The SDKs
		// are private dependencies of the provider packages, so a nested
		// consumer install resolves them next to the provider, never through
		// a hoisted root that may not exist.
		case "anthropic": {
			const { createAnthropicProvider } = await import("@vincemakes/kiso-provider-anthropic");
			return createAnthropicProvider({
				...(definition.apiKey !== undefined ? { apiKey: definition.apiKey } : {}),
				...(definition.baseUrl !== undefined ? { baseUrl: definition.baseUrl } : {}),
			});
		}
		case "openai-compat": {
			const { createOpenAICompatProvider } = await import("@vincemakes/kiso-provider-openai");
			return createOpenAICompatProvider({
				...(definition.apiKey !== undefined ? { apiKey: definition.apiKey } : {}),
				...(definition.baseUrl !== undefined ? { baseUrl: definition.baseUrl } : {}),
			});
		}
		default:
			throw new Error("createAgent: pass an `adapter` or a `provider` (\"anthropic\" | \"openai-compat\")");
	}
}

