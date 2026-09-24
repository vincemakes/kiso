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
	/** 0.40.0: the root a NEW session starts in, recorded once in its
	 *  profile (revision 1) — the resume picker scopes by it. Never read
	 *  for an existing session: where it started is history. */
	readonly workspace?: string;
	/** 0.40.0: the config profile that named this binding, recorded per
	 *  revision for display. Never part of drift. */
	readonly profileName?: string;
	/** `Tool<any>` like the registry: typed tools register without casts. */
	readonly tools: readonly Tool<any>[];
	readonly store: SessionStore;
	readonly permissionPolicy?: PermissionPolicy;
	/** Raw loop hooks (observers, custom permission logic). */
	readonly hooks?: HookHost;
	/** Direct adapter injection (tests, faux, custom providers). */
	readonly adapter?: Adapter;
	/** Lazy provider: "anthropic" | "openai-compat" | "openai-responses"
	 *  (imports the peer package). */
	readonly provider?: "anthropic" | "openai-compat" | "openai-responses";
	readonly apiKey?: string;
	readonly baseUrl?: string;
	/** OR-1: the Responses adapter's ChatGPT target — a thunk that yields
	 *  a FRESH token per request (the CLI's calls the credential store's
	 *  refresh). Its presence is what selects that target; `apiKey`
	 *  selects the first-party one. Ignored by the other providers. */
	readonly oauth?: () => Promise<{ readonly access: string; readonly accountId: string }>;
	/** OR-1: the ChatGPT backend's prefix-cache key — the session id, so
	 *  one session's requests share a cache lane. */
	readonly promptCacheKey?: string;
	/** PH-1c.1: opt-in Anthropic prompt caching (cache_control
	 *  breakpoints) — OFF by default; the openai-compat path ignores it
	 *  (that dialect's caching is server-automatic). Type-only additive. */
	readonly promptCaching?: boolean;
	/** Headers the endpoint needs on every request (a gateway's session
	 *  header, say), passed to whichever provider builds the adapter.
	 *  Never a credential — that is `apiKey` / `oauth`. Type-only additive. */
	readonly headers?: Readonly<Record<string, string>>;
	readonly maxTurns?: number;
	readonly maxTokens?: number;
	readonly temperature?: number;
	/** C area: microcompact threshold — passed through to every session. */
	readonly microcompact?: { readonly thresholdTokens: number };
	/** E6: the session context policy (run-start actions, injection-side only). */
	readonly contextPolicy?: import("./session.js").ContextPolicy;
	readonly maxRetries?: number;
	/** LT-1: the stream watchdog — milliseconds between adapter events
	 *  before the request is aborted and retried (default 120 s; 0 off).
	 *  Type-only additive; read by the runtime's idle guard. */
	readonly streamIdleMs?: number;
	/** R1 (2026-09-23): the tool table's vocabulary rows — the product's
	 *  routing policy, one line per tool NAME, injected only while that tool
	 *  is active. Absent = no vocabulary lines (the fixed directives and the
	 *  tools' own snippets still compose). Type-only additive; never part of
	 *  the profile digest. */
	readonly toolRules?: ReadonlyArray<{ readonly tool: string; readonly line: string }>;
	/** 0.42.0: "off" withholds the generated "Tool use:" block entirely —
	 *  no fixed directives, no snippets, no guidelines — so the system
	 *  prompt is exactly the configured text (a host matching another
	 *  system byte for byte). The tool schemas still ride the request.
	 *  Default "on". Type-only additive; never part of the profile digest. */
	readonly toolTable?: "on" | "off";
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
			// CX-1 F7a (audit F7): extension tools are reached ONLY through
			// their live source — never frozen into static entries that would
			// win every lookup and mask a background refresh (the MCP bridge
			// replacing its cached definitions). The loud startup collision
			// stays: a startup tool sharing a built-in's name (or an earlier
			// extension's) throws here, at agent creation.
			for (const tool of ext.tools ?? []) {
				if (this.#registry.has(tool.name)) throw new Error(`Tool already registered: ${tool.name} (extension ${ext.name})`);
			}
			this.#registry.registerLive(() => ext.tools ?? [], ext.name);
		}
		this.#adapterPromise = resolveAdapter(definition);
	}

	/** The ids alone, from the directory — no log is read (store.ids). */
	sessionIds(): string[] {
		return this.#definition.store.ids();
	}

	/** Session metadata for listings (`kiso sessions`). */
	sessions() {
		return this.#definition.store.list();
	}

	/** Release every held fd and writer lock (E group: the CLI closes on exit). */
	close(): void {
		this.#definition.store.closeAll();
	}

	/** Load an existing session from disk, or create a fresh one.
	 *
	 *  `acceptDrift` is accepted and INERT — the CLI's historical
	 *  `--accept-drift`, kept so the flag keeps parsing. Since the owner's
	 *  ruling of 2026-09-21 a changed binding never needs an
	 *  acknowledgement: the current configuration wins and is recorded. */
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
			profileName: this.#definition.profileName ?? null,
			workspace: this.#definition.workspace ?? null,
			...(this.#definition.systemPrompt !== undefined ? { systemPrompt: this.#definition.systemPrompt } : {}),
			registry: this.#registry,
		});
		let restored: { model: string; reasoning: import("./provider/metadata.js").ReasoningSetting; scope: typeof startupScope } | null = null;
		let profilePending = false;
		let newSession: { readonly workspace: string | null } | null = null;
		let driftAcknowledgement: DriftAcknowledgement | null = null;
		if (meta.kind === "ok") {
			const drift = assessProfileDrift(meta.profile, {
				provider: startupScope ?? null,
				modelId: this.#definition.model,
				systemPromptDigest: candidate.systemPromptDigest,
				tools: candidate.tools,
			});
			if (drift.kind === "material") {
				// 0.40.1 (the owner's ruling of 2026-09-21): a DIFFERENT BINDING
				// never blocks. A person may simply have switched models, so the
				// CURRENT configuration wins — DURABLY, as the next revision —
				// and the session says so. It used to refuse without an explicit
				// `acceptDrift`, which turned "I moved to another provider"
				// into an error the resume could not pass at all.
				//
				// Nothing provider-specific crosses the change: every adapter
				// withholds foreign reasoning/continuation (MG-1 A5), so a new
				// binding loses cache state, never correctness. The reasoning
				// resets to defaults (owner-ruled: the recorded effort was a
				// choice for the model that no longer answers) — and the session
				// says so through `driftAcknowledgement`. The field's NAME is
				// history: nothing is acknowledged any more, the change is
				// recorded and stated.
				driftAcknowledgement = { reasons: drift.reasons, reasoningReset: meta.profile.reasoning };
				writeProfile(store.root, options.id, {
					...buildProfile({
						revision: meta.profile.revision + 1,
						modelId: this.#definition.model,
						provider: startupScope ?? null,
						profileName: this.#definition.profileName ?? null,
						// history: where the session started is not where the
						// acknowledging process happens to be
						workspace: meta.profile.workspace,
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
			// a NEW session. DC-60: nothing of it reaches the disk before its
			// first durable event — revision 1 (with the workspace it opened in)
			// lands WITH that event, still before it (session.ts persist).
			newSession = { workspace: candidate.workspace };
		} else {
			// legacy (pre-XP log, no sidecar): generation absence is not
			// drift — restore under current configuration; revision 1 lands
			// at the next explicit selection or first request.
			profilePending = true;
		}
		const config: SessionConfig = {
			model: restored?.model ?? this.#definition.model,
			...(this.#definition.provider !== undefined ? { provider: this.#definition.provider } : {}),
			// OR-1: the endpoint rides with the provider — the cost path and
			// the window lookup key on (model, endpoint), never on the id alone.
			...(this.#definition.baseUrl !== undefined ? { baseUrl: this.#definition.baseUrl } : {}),
			...((restored !== null ? restored.scope : startupScope) !== undefined
				? { continuationScope: (restored !== null ? restored.scope : startupScope)! }
				: {}),
			...(restored !== null ? { reasoning: restored.reasoning } : {}),
			...(profilePending ? { profilePending: true } : {}),
			...(newSession !== null ? { newSession } : {}),
			...(this.#definition.profileName !== undefined ? { profileName: this.#definition.profileName } : {}),
			...(driftAcknowledgement !== null ? { driftAcknowledgement } : {}),
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
			...(this.#definition.microcompact !== undefined ? { microcompact: this.#definition.microcompact } : {}),
			...(this.#definition.contextPolicy !== undefined ? { contextPolicy: this.#definition.contextPolicy } : {}),
			...(this.#definition.maxRetries !== undefined ? { maxRetries: this.#definition.maxRetries } : {}),
			...(this.#definition.streamIdleMs !== undefined ? { streamIdleMs: this.#definition.streamIdleMs } : {}),
			...(this.#definition.toolRules !== undefined ? { toolRules: this.#definition.toolRules } : {}),
			...(this.#definition.toolTable !== undefined ? { toolTable: this.#definition.toolTable } : {}),
			...(this.#definition.extensions !== undefined ? { extensions: this.#definition.extensions } : {}),
		};
		// 0.40.0: the last bill's time rides the RECORD, not the event.
		let lastUsageAt: number | undefined;
		for (let i = records.length - 1; i >= 0; i--) {
			const e = records[i]!.event;
			if (e.type === "usage" && e.known) {
				lastUsageAt = records[i]!.ts;
				break;
			}
		}
		return new AgentSession(options.id, log, store, adapter, config, lastUsageAt);
	}
}

/** 0.40.0 — what an acknowledged drift replaced: the reasons it was
 *  material, and the reasoning setting the acknowledgement reset. */
export interface DriftAcknowledgement {
	readonly reasons: readonly string[];
	readonly reasoningReset: import("./provider/metadata.js").ReasoningSetting;
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
	provider: "anthropic" | "openai-compat" | "openai-responses",
	opts: {
		readonly apiKey?: string;
		readonly baseUrl?: string;
		readonly promptCaching?: boolean;
		readonly oauth?: () => Promise<{ readonly access: string; readonly accountId: string }>;
		readonly promptCacheKey?: string;
		readonly headers?: Readonly<Record<string, string>>;
	} = {},
): Promise<Adapter> {
	// resolveAdapter consumes only the provider-side fields of the
	// definition (credential, endpoint, caching, headers) — the rest is
	// irrelevant for a bare adapter build.
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
				...(definition.headers !== undefined ? { headers: definition.headers } : {}),
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
				...(definition.headers !== undefined ? { headers: definition.headers } : {}),
				...(scope !== undefined
					? { scope: { providerId: scope.providerId, ...(scope.endpoint !== undefined ? { endpoint: scope.endpoint } : {}) } }
					: {}),
			});
		}
		case "openai-responses": {
			const { createOpenAIResponsesProvider } = await import("@vincemakes/kiso-provider-openai-responses");
			// MG-1 (A5): the adapter's replay identity is the SAME one the
			// run's stamping scope uses, so emit and replay agree — the
			// openai-compat case's rule, one dialect over.
			const scope = resolveContinuationScope("openai-responses", "", definition.baseUrl);
			// The adapter picks its TARGET from these options — an `oauth`
			// thunk is the ChatGPT backend, an `apiKey` is the first-party
			// API — so no separate switch exists to disagree with the
			// credential the CLI resolved.
			return createOpenAIResponsesProvider({
				...(scope !== undefined ? { scope: { providerId: scope.providerId } } : {}),
				...(definition.apiKey !== undefined ? { apiKey: definition.apiKey } : {}),
				...(definition.oauth !== undefined ? { oauth: definition.oauth } : {}),
				...(definition.baseUrl !== undefined ? { baseUrl: definition.baseUrl } : {}),
				...(definition.promptCacheKey !== undefined ? { promptCacheKey: definition.promptCacheKey } : {}),
				...(definition.headers !== undefined ? { headers: definition.headers } : {}),
			});
		}
		default:
			throw new Error("createAgent: pass an `adapter` or a `provider` (\"anthropic\" | \"openai-compat\" | \"openai-responses\")");
	}
}

