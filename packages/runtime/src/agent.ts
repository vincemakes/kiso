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

import { EventLog, ToolRegistry, type Adapter, type HookHost, type Tool } from "@kiso/core";
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
	readonly compaction?: { readonly thresholdTokens: number };
	readonly maxRetries?: number;
}

export class AgentRuntime {
	readonly #definition: AgentDefinition;
	readonly #registry: ToolRegistry;
	readonly #adapterPromise: Promise<Adapter>;

	constructor(definition: AgentDefinition) {
		this.#definition = definition;
		this.#registry = new ToolRegistry();
		for (const tool of definition.tools) this.#registry.register(tool);
		this.#adapterPromise = resolveAdapter(definition);
	}

	sessionIds(): string[] {
		return this.#definition.store.list().map((m) => m.id);
	}

	/** Session metadata for listings (`kiso sessions`). */
	sessions() {
		return this.#definition.store.list();
	}

	/** Release every held fd and writer lock (E 组: the CLI closes on exit). */
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
			...(this.#definition.maxRetries !== undefined ? { maxRetries: this.#definition.maxRetries } : {}),
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

async function resolveAdapter(definition: AgentDefinition): Promise<Adapter> {
	if (definition.adapter) return definition.adapter;
	switch (definition.provider) {
		// 七: the runtime imports ONLY the provider package — its high-level
		// factory owns the SDK and builds the adapter from config. The SDKs
		// are private dependencies of the provider packages, so a nested
		// consumer install resolves them next to the provider, never through
		// a hoisted root that may not exist.
		case "anthropic": {
			const { createAnthropicProvider } = await import("@kiso/provider-anthropic");
			return createAnthropicProvider({
				...(definition.apiKey !== undefined ? { apiKey: definition.apiKey } : {}),
				...(definition.baseUrl !== undefined ? { baseUrl: definition.baseUrl } : {}),
			});
		}
		case "openai-compat": {
			const { createOpenAICompatProvider } = await import("@kiso/provider-openai");
			return createOpenAICompatProvider({
				...(definition.apiKey !== undefined ? { apiKey: definition.apiKey } : {}),
				...(definition.baseUrl !== undefined ? { baseUrl: definition.baseUrl } : {}),
			});
		}
		default:
			throw new Error("createAgent: pass an `adapter` or a `provider` (\"anthropic\" | \"openai-compat\")");
	}
}

