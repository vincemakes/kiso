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

import { resolveContinuationScope } from "./provider/manifest.js";
import { assessProfileDrift, buildProfile, profilePath, readProfile, writeProfile } from "./profile.js";
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
	/** PH-1c.1: opt-in Anthropic prompt caching (cache_control
	 *  breakpoints) — OFF by default; the openai-compat path ignores it
	 *  (that dialect's caching is server-automatic). Type-only additive. */
	readonly promptCaching?: boolean;
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
	/** E6: the session context policy (run-start actions, injection-side only). */
	readonly contextPolicy?: import("./session.js").ContextPolicy;
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
	async session(options: { id: string; acceptDrift?: boolean }): Promise<AgentSession> {
		const store = this.#definition.store;
		const records = store.load(options.id);
		const log = new EventLog(records.map((r) => r.event));
		const adapter = await this.#adapterPromise;
		const startupScope = resolveContinuationScope(this.#definition.provider, this.#definition.model, this.#definition.baseUrl);
		// ── XP-1: the durable execution profile, FAIL-CLOSED ─────────────
		const meta = readProfile(store.root, options.id);
		if (meta.kind === "corrupt") {
			throw new Error(
				`the session profile ${profilePath(store.root, options.id)} is unreadable (${meta.error}) — BLOCKED: restore the file, or re-create the session; a corrupt profile is never silently rebuilt under today's defaults`,
			);
		}
		const hasEnvelope = log.all.some((e) => e.type === "stop" && (e as { continuation?: unknown }).continuation !== undefined);
		if (meta.kind === "absent" && hasEnvelope) {
			throw new Error(
				`the session log carries scoped continuation envelopes but ${profilePath(store.root, options.id)} is missing — BLOCKED: an XP-era session without its profile is an integrity failure, never a legacy session`,
			);
		}
		// The CURRENT candidate — what THIS process would run.
		const candidate = buildProfile({
			revision: 0,
			modelId: this.#definition.model,
			provider: startupScope ?? null,
			...(this.#definition.systemPrompt !== undefined ? { systemPrompt: this.#definition.systemPrompt } : {}),
			registry: this.#registry,
		});
		let restored: { model: string; reasoning: import("./provider/metadata.js").ReasoningSetting; scope: typeof startupScope } | null = null;
		let profilePending = false;
		if (meta.kind === "ok") {
			const drift = assessProfileDrift(meta.profile, {
				provider: startupScope ?? null,
				systemPromptDigest: candidate.systemPromptDigest,
				tools: candidate.tools,
			});
			if (drift.kind === "material" && options.acceptDrift !== true) {
				const listed = drift.reasons.map((r) => `- ${r}`).join("\n");
				throw new Error(
					`the recorded execution profile no longer matches this process:\n${listed}\nre-open with acceptDrift (the CLI's --accept-drift flag) to proceed under the CURRENT configuration — the acknowledgement is recorded as a new revision; silently rebuilding is forbidden`,
				);
			}
			if (drift.kind === "material") {
				// acknowledged: the current configuration wins, DURABLY.
				writeProfile(store.root, options.id, {
					...buildProfile({
						revision: meta.profile.revision + 1,
						modelId: this.#definition.model,
						provider: startupScope ?? null,
						...(this.#definition.systemPrompt !== undefined ? { systemPrompt: this.#definition.systemPrompt } : {}),
						registry: this.#registry,
					}),
				});
			} else {
				// RESTORE — the recorded profile wins over the process default
				// (the truthfulness core: the row and the request agree).
				const scope = meta.profile.provider === null ? undefined : meta.profile.provider;
				restored = { model: meta.profile.modelId, reasoning: meta.profile.reasoning, scope };
			}
		} else if (log.all.length === 0) {
			// a NEW session: revision 1 lands BEFORE any durable event.
			writeProfile(store.root, options.id, { ...candidate, revision: 1 });
		} else {
			// legacy (pre-XP log, no sidecar): generation absence is not
			// drift — restore under current configuration; revision 1 lands
			// at the next explicit selection or first request.
			profilePending = true;
		}
		const config: SessionConfig = {
			model: restored?.model ?? this.#definition.model,
			...(this.#definition.provider !== undefined ? { provider: this.#definition.provider } : {}),
			...((restored !== null ? restored.scope : startupScope) !== undefined
				? { continuationScope: (restored !== null ? restored.scope : startupScope)! }
				: {}),
			...(restored !== null ? { reasoning: restored.reasoning } : {}),
			...(profilePending ? { profilePending: true } : {}),
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
			...(this.#definition.contextPolicy !== undefined ? { contextPolicy: this.#definition.contextPolicy } : {}),
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
	opts: { readonly apiKey?: string; readonly baseUrl?: string; readonly promptCaching?: boolean } = {},
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
				...(definition.promptCaching !== undefined ? { promptCaching: definition.promptCaching } : {}),
			});
		}
		case "openai-compat": {
			const { createOpenAICompatProvider } = await import("@vincemakes/kiso-provider-openai");
			// MG-1 (A5): the adapter's replay identity — the SAME resolution
			// the run's stamping scope uses, so emit and replay agree.
			const scope = resolveContinuationScope("openai-compat", "", definition.baseUrl);
			return createOpenAICompatProvider({
				...(definition.apiKey !== undefined ? { apiKey: definition.apiKey } : {}),
				...(definition.baseUrl !== undefined ? { baseUrl: definition.baseUrl } : {}),
				...(scope !== undefined
					? { scope: { providerId: scope.providerId, ...(scope.endpoint !== undefined ? { endpoint: scope.endpoint } : {}) } }
					: {}),
			});
		}
		default:
			throw new Error("createAgent: pass an `adapter` or a `provider` (\"anthropic\" | \"openai-compat\")");
	}
}

