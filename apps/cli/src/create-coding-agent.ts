/**
 * kiso-code's composition root — the product's choices (trust, config,
 * credentials, the coding tools, the built-in and loaded extensions, the
 * coding prompt, the mode tiers) bound into ONE AgentDefinition and handed
 * to runtime.createAgent(): the one door every agent goes through.
 *
 * Moved verbatim from index.ts's makeAgent (R1, 2026-09-23) and renamed;
 * the body is not edited beyond the rename and activeStoreDir's setter.
 */

import { activeStoreDir, childTurnBudget, setActiveStoreDir, body, bodyLog, codingToolOptions, extensionsDir, floorOn, kisoHome, loadedExtensions, ownSessionsDir, projectRoot, protectedFiles, secretEnvNamesOf, sessionsDir, setAgentModel, setConfigModels, setConfiguredWindow, setCurrentAgentExtensions, setCurrentFaux, setCurrentModelName, setCurrentProfileName, setExtensionLists, setFloorOn, setMergedConfig, setModelChoice, setNeverInherited, setRetryShown, setSessionStore, setUserProtectedPaths, settingsLayers, workspaceRoot, type LineInput } from "./state.js";
import { claimProjectDir, projectLayoutActive } from "./projects.js";
import { migrationNotice, pendingLegacyIds, planMigration, runMigration } from "./session-migration.js";
import { askUi, resolveProjectTrust } from "./trust-ui.js";
import { isFirstRun, scaffoldFirstRun } from "./first-run.js";
import { fauxSkip, readFauxScript } from "./faux-glue.js";
import { loadProjectConfig, loadUserConfig, mergeConfigs, resolveContextWindow, resolveModel } from "./config.js";
import { builtInLayer } from "./builtin.js";
import { recordLearnedWindow, useLearnedWindows } from "./learned-windows.js";
import { compactionDiscardedNotice, contextWindowTokens, knownContextWindow, unknownWindowNotice, windowLearnedNotice } from "./chat.js";
import { type PolicyCall } from "@vincemakes/kiso-core";
import { guardSavedAllow, isProtectedWrite } from "./protected-writes.js";
import { floorExtension, isDestructiveCall } from "./floor.js";
import { protectedShellExtension } from "./protected-shell.js";
import { homedir } from "node:os";
import { breakerExtension } from "./breaker.js";
import { modeExtensions, modeSystemPrompt } from "./mode.js";
import { readOnlyShellExtension } from "./readonly-shell.js";
import { maxRetriesFromEnv } from "./retries.js";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { runsACheck } from "@vincemakes/kiso-runtime/internal";
import { providerHost } from "./provider-label.js";
import { adapterOptionsFor } from "./auth/adapter-options.js";
import { createFauxProvider } from "@vincemakes/kiso-evals";
import { sweepStaleMergeDirs } from "./temp-sweep.js";
import { CODING_TOOL_RULES, composeSystemPrompt } from "./coding-prompt.js";
import { createAgent, loadExtensions, loadProjectExtensions, SessionStore, type AgentDefinition, type ContextPolicy } from "@vincemakes/kiso-runtime";

/** LT-1: the stream watchdog's bound from the environment — a non-negative
 *  number of milliseconds (0 disables it); anything else is ignored. The
 *  PTY rigs use it to trip the watchdog in seconds against a stub that
 *  never finishes a stream. */
function streamIdleFromEnv(): number | undefined {
	const raw = process.env.KISO_STREAM_IDLE_MS;
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * E6: the run-start context policy, OFF unless env-armed (invalid values
 * are ABSENT, never a crash — the autoCompactFromEnv convention).
 * The product arming is KISO_CONTEXT_WINDOW → window − POLICY_RESERVE
 * (the window rides the config as windowTokens; the runtime owns the
 * arithmetic — never a fixed low absolute). KISO_POLICY_SUMMARY_TRIGGER
 * survives ONLY as the legacy absolute override when no window is set
 * (bench back-compat); the window wins when both are set.
 * KISO_POLICY_SUMMARY_KEEP (rounds) and KISO_POLICY_SUMMARY_KEEP_TOKENS
 * override the runtime defaults (KEEP_RECENT_ROUNDS = 4,
 * KEEP_TOKENS_DEFAULT = 20,000) — emitted only when set.
 * KISO_POLICY_SUMMARY_MAX_FAILURES overrides the (h) circuit-breaker
 * default (MAX_SUMMARY_FAILURES = 3).
 * KISO_POLICY_DROP=1 switches the armed mode to the crux C arm
 * (mechanical drop — same trigger/keep envs); KISO_POLICY_MICROCOMPACT
 * arms the session-aware override (MIN_TURNS = the no-fire guard).
 */
export function contextPolicyFromEnv(): ContextPolicy | undefined {
	const summaryTrigger = positiveIntEnv("KISO_POLICY_SUMMARY_TRIGGER");
	const contextWindow = positiveIntEnv("KISO_CONTEXT_WINDOW");
	const microcompactTrigger = positiveIntEnv("KISO_POLICY_MICROCOMPACT");
	if (summaryTrigger === undefined && contextWindow === undefined && microcompactTrigger === undefined) return undefined;
	return {
		...(summaryTrigger === undefined && contextWindow === undefined ? {} : {
			[(process.env.KISO_POLICY_DROP === "1" ? "drop" : "summary")]: {
				...(contextWindow !== undefined ? { windowTokens: contextWindow } : summaryTrigger !== undefined ? { triggerTokens: summaryTrigger } : {}),
				...kv("keepRounds", "KISO_POLICY_SUMMARY_KEEP"),
				...kv("keepTokens", "KISO_POLICY_SUMMARY_KEEP_TOKENS"),
				...kv("maxFailures", "KISO_POLICY_SUMMARY_MAX_FAILURES"),
			},
		}),
		...(microcompactTrigger !== undefined ? { microcompact: { thresholdTokens: microcompactTrigger, ...kv("keepResults", "KISO_POLICY_MICROCOMPACT_KEEP"), ...kv("minTurns", "KISO_POLICY_MICROCOMPACT_MIN_TURNS") } } : {}),
	};
}

/** { [key]: value } when the env int is set — the spread-friendly optional field. */
function kv(key: string, env: string): { [key: string]: number } | undefined {
	const v = positiveIntEnv(env);
	return v !== undefined ? { [key]: v } : {};
}

/** Parse a positive-int env var — absent or invalid is undefined (no crash). */
function positiveIntEnv(name: string): number | undefined {
	const n = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * 0.40.0 — before any session opens: the one-time move of the legacy
 * folder into project folders (announced once, with the undo), then this
 * project's folder claimed. Nothing happens under a pinned folder or after
 * a reversed migration.
 */
function prepareSessionFolders(): void {
	const home = kisoHome();
	if (!projectLayoutActive(home)) return;
	if (pendingLegacyIds(home).length > 0) {
		const result = runMigration(home, planMigration(home));
		if (result !== null && result.moved > 0) {
			const line = migrationNotice(result);
			if (process.stdout.isTTY) bodyLog(line);
			else process.stderr.write(`${line}\n`);
		}
	}
	claimProjectDir(ownSessionsDir(), projectRoot());
}

/** 0.40.7: the stale-merge-directory sweep runs once per process. */
let tempSwept = false;
/** Said once per process: the window is unknown, so no ctx gauge. */
let unknownWindowNoticed = false;

export async function createCodingAgent(sessionId: string | undefined, input?: LineInput, modelFlag?: string) {
	// §2.5: the ONE source a reload reads for the model, seeded here from
	// the startup flag. Without this a session started with `--model X`
	// would silently revert to the env/config default on its first reload.
	if (modelFlag !== undefined) setModelChoice(modelFlag);
	// E3: the project-level trust gate runs BEFORE any extension load (the
	// mcp/skills merges must be in the env when the user-level extensions
	// load). Untrusted project capability is never loaded — never silently.
	const project = input !== undefined ? await resolveProjectTrust(input) : await resolveProjectTrust(undefined as unknown as LineInput);

	// R-D 0.1.45 (deliverable B): the first-run scaffold lands AFTER the
	// verdict — pre-trust zero-read/write/scan is absolute. The sessions
	// dir (SessionStore's constructor mkdirs) moved behind the gate too:
	// the trust record is the first home write, the scaffold the second.
	if (isFirstRun()) scaffoldFirstRun();
	// 0.40.0 — one folder per project: the one-time move of the legacy
	// folder, then this project's folder claimed (made, its workspace
	// recorded). Both write, so both sit behind the verdict, with the store.
	prepareSessionFolders();
	setActiveStoreDir(sessionsDir());
	const store = new SessionStore(activeStoreDir);
	// TUI2-R2 ②/③: the navigation surfaces read through THIS store — one
	// store per process, and the picker/listing never write through it.
	setSessionStore(store);
	// E area: the durable script position — computed AFTER the verdict
	// (fauxSkip's session-log read is a home read: pre-trust zero-read).
	const fauxSkipTurns = sessionId === undefined ? 0 : fauxSkip(sessionId);
	// E1: the startup extension scan — a broken extension fails the process
	// LOUDLY here (loadExtensions throws), never silently.
	const user = await loadExtensions(extensionsDir());
	const proj = project !== null ? await loadProjectExtensions(process.cwd(), user) : [];
	// R-D 0.1.45: the built-in layer registers by module import (builtin.ts)
	// — a user extension may shadow a built-in, a project one may not.
	// KC3.5: built-in #4 (ask) registers ONLY where a human can answer —
	// the panel bridge is the argument, and a non-TTY session has none to
	// give. A piped run's composed tool table therefore cannot contain
	// ask_user (T-Q3: the bench's structural byte-identity proof).
	// Astra F7: the config is READ here — a pure read, its setters still run
	// below with the rest of merge round B — because the mcp extension spawns
	// its stdio children while it is being constructed, and the strip needs
	// the configured secret names by then.
	const userCfg = loadUserConfig();
	const projectCfg = loadProjectConfig(process.cwd(), project !== null);
	const merged = mergeConfigs(userCfg, projectCfg);
	// 0.40.6: /settings names each value's layer from these
	settingsLayers.user = userCfg;
	settingsLayers.project = projectCfg;
	settingsLayers.modelFlag = modelFlag;
	const secretEnvNames = secretEnvNamesOf(merged.models ?? {});
	const builtIn = await builtInLayer(user, proj, input !== undefined && process.stdin.isTTY ? askUi(input) : undefined, secretEnvNames);
	setExtensionLists(builtIn, user, proj, [...builtIn, ...user, ...proj]);

	// merge round B — the config surface: user config + (trusted) project config,
	// resolved with flags > env > project > user > default. The CLI never
	// imports provider SDKs directly — the runtime's lazy provider
	// resolution owns them (a config profile only ever NAMES an env var for
	// its key; the key itself never sits in a config file).
	setMergedConfig(merged);
	// DT-1a: what a delegated task may NAME — the configured checks and the
	// model profiles — handed to the (in-process) subagent extension through
	// the environment. A model never supplies a command; it names a check.
	// 0.40.0: and the folder this process keeps its sessions in — a child
	// writes beside its parent, whatever directory it runs in. Through this
	// channel and not an exported KISO_SESSIONS_DIR: a variable in
	// process.env would reach every shell child, and a kiso started from a
	// shell tool would then write into this project's folder.
	process.env.KISO_DELEGATION_CONFIG_JSON = JSON.stringify({ checks: merged.checks ?? {}, evaluators: merged.evaluators ?? [], profiles: Object.keys(merged.models ?? {}), sessionsDir: sessionsDir() });
	setConfigModels(merged.models ?? {});
	// CW-1 batch 2: the windows endpoints stated by refusing — read before the
	// first window is asked for (the unknown-window notice below).
	useLearnedWindows();
	// 0.40.7: the merge directories a killed kiso left in the temp dir —
	// once per process, never this process's own (temp-sweep.ts)
	if (!tempSwept) {
		tempSwept = true;
		sweepStaleMergeDirs();
	}

	const resolved = resolveModel(modelFlag, merged);
	// AFTER the model resolves: the window a PROFILE states is about that
	// profile's model, so it cannot be read before we know which profile is
	// selected. Reading it a line too early is how the compaction threshold
	// ended up frozen at the wrong model's value (CTX-1).
	setConfiguredWindow(resolveContextWindow(merged, resolved?.profile));
	const model = resolved === null ? "faux" : resolved.profile.model;
	if (resolved === null) {
		console.log(
			"[faux mode — set ANTHROPIC_API_KEY or OPENAI_API_KEY, or configure models in ~/.kiso/config.json]\n",
		);
		setCurrentFaux(true);
		setCurrentModelName("faux");
		setCurrentProfileName(null);
	} else {
		setCurrentFaux(false);
		setCurrentModelName(resolved.name);
		setCurrentProfileName(resolved.name);
	}
	setAgentModel(model, resolved?.profile.baseUrl); // v2b: the status bar shows it; OR-1: the endpoint rides along
	// ADR-0055 Amendment 2: the row says `ctx ?` for an unstated window, but
	// the tiers still need a number and assume the fallback — say so, once,
	// at build.
	if (!unknownWindowNoticed && knownContextWindow() === null) {
		unknownWindowNoticed = true;
		console.error(unknownWindowNotice(model));
	}

	// W21: the extensions array is built ONCE per agent and shared with
	// the runtime by reference — the don't-ask-again writer pushes the
	// generated extension into it so a first-time rule joins the chain
	// at the NEXT run (the run's policies are fixed at its start; run.ts
	// re-reads the config's extensions array per run).
	// LT-2: the loop breaker at the chain HEAD — it speaks first when it speaks,
	// so `decidedBy` names it; a deny there beats every tier, bypass included.
	// 0.40.0: the read-only shell allow sits after the tiers — an allow from
	// it outranks a tier's ask and names itself in decidedBy.
	// 0.40.0: a saved allow never carries a write into .git/ or .kiso/, nor
	// a destructive shell command.
	const workspaceRoot = (): string => codingToolOptions().workspaceRoot;
	const neverInherited = (call: PolicyCall): boolean => isProtectedWrite(call, workspaceRoot()) || isDestructiveCall(call);
	setNeverInherited(neverInherited);
	// 0.40.0: the catastrophe floor, at the chain's HEAD — a deny there
	// names itself in decidedBy and outranks every tier, bypass included.
	// Read per agent, so /reload picks up an edited user config.
	const userConfig = loadUserConfig();
	setFloorOn(userConfig?.floor !== "off");
	// kiso never serves its own credential store to a model: the file tools
	// refuse it through codingToolOptions, and this member denies a shell
	// line naming it — at the HEAD with the floor, in every mode, and NOT
	// switched off with it (`floor: "off"` lowers the catastrophe floor,
	// never this).
	setUserProtectedPaths(userConfig?.protectedPaths);
	const extensions = [
		protectedShellExtension({ files: protectedFiles, workspaceRoot, env: () => ({ home: homedir(), kisoHome: kisoHome() }) }),
		floorExtension(() => floorOn, workspaceRoot),
		breakerExtension(),
		...modeExtensions(workspaceRoot),
		readOnlyShellExtension(codingToolOptions),
		...loadedExtensions.map((e) => guardSavedAllow(e, neverInherited)),
	];
	setCurrentAgentExtensions(extensions);

	// E6: the run-start context policy (captured once — exactOptionalPropertyTypes).
	const contextPolicy = contextPolicyFromEnv();
	const idleFromEnv = streamIdleFromEnv(); // read once: a narrowed const, not a call per spread
	const retriesFromEnv = maxRetriesFromEnv();
	const definition: AgentDefinition = {
		model,
		store,
		// 0.40.0: a NEW session records where it started; the picker scopes by
		// it. The profile name is recorded only when the model came from a
		// config profile — a direct provider/model or an env key names none.
		workspace: workspaceRoot(),
		...(resolved !== null && merged.models?.[resolved.name] === resolved.profile ? { profileName: resolved.name } : {}),
		// Area 5: the coding tools are bound to the workspace — every path
		// they touch is canonicalized inside cwd, escapes are refused.
		tools: [...createCodingTools(codingToolOptions())], // DC-49 — the options live in state.ts, shared with the `!` command's runner
		toolRules: CODING_TOOL_RULES, // R1: the product's rows, in the runtime's table
		// Modes: the five tiers ride the E1 policy chain (mode:<tier>
		// extensions, current tier first) — the old static PERMISSION_POLICY
		// is gone, its semantics live in the "default" tier. The banner
		// still counts loadedExtensions only — the modes are in-process,
		// never a file extension.
		systemPrompt: (() => {
			const sp = composeSystemPrompt(process.cwd(), protectedFiles());
			const extra = modeSystemPrompt();
			return extra === undefined ? sp : `${sp}\n\n${extra}`;
		})(),
		// ADR-0055 Amendment 1 (A1b): compaction is ON by default and runs
		// INSIDE a run, by tiers drawn from the model's window (CTX-1: the
		// binding step moves the window with /model and /resume). The
		// standing microcompact at half the window is gone (A4). Phase rule
		// 1 reads the user's configured checks first, then the runner table.
		contextPolicy: {
			...(contextPolicy ?? {}),
			tiers: {
				windowTokens: contextWindowTokens(),
				isCheck: (command: string) => runsACheck(command, Object.values(merged.checks ?? {})),
				// ADR-0055 Amendment 2: a discarded checkpoint says so, in sizes only.
				onDiscard: (d) => body.notice(compactionDiscardedNotice(d)),
				// ADR-0055 Amendment 2 (decision 3): only a window someone stated
				// arms the overflow belt — read from the LIVE binding, so it moves
				// with /model and /resume; the fallback reads as null.
				statedWindow: () => knownContextWindow(),
				// CW-1 batch 2: an endpoint's refusal stated its cap. The tiers
				// took it already; kept, it is where the next session starts, and
				// the status row's denominator moves with it. Said once per new
				// figure — a refusal at a cap already kept says nothing.
				onWindowLearned: (w) => {
					if (recordLearnedWindow(w.model, w.baseUrl, w.tokens)) body.notice(windowLearnedNotice(w.model, providerHost(w.baseUrl) ?? "", w.tokens));
				},
			},
		},
		// R3e (owner ruling, 2026-08-28): NO turn limit on an interactive
		// session. This was `maxTurns: 20`, hardcoded on 2026-08-03 with no
		// stated reason and no way to change it — and it was the thing that
		// stopped a real 43-call session dead, mid-task, in silence. The
		// field survives for the callers that want a bound (subagents, the
		// SDK, `kiso run`); the interactive front door does not set one.
		// Modes: the five tiers join at the CHAIN HEAD, before the user/
		// project extensions (the deny>allow>ask composition keeps a user
		// deny winning over any mode tier — bypass included).
		// ADR-0058 3d (D6): a background child's budget, its only bound.
		...(childTurnBudget !== undefined ? { maxTurns: childTurnBudget } : {}),
		extensions,
		...(resolved !== null
			? {
					provider: resolved.profile.kind,
					// Astra F1 (P0): the wire config is built in ONE place
					// (auth/adapter-options.ts) — credential shape, the ALWAYS
					// EXPLICIT endpoint, the session's cache key and the
					// profile's caching flag. This site and the `/model` site
					// were the same spread written twice.
					...adapterOptionsFor(
						resolved.profile,
						resolved.oauthProviderId !== undefined
							? { type: "oauth", providerId: resolved.oauthProviderId }
							: { type: "api-key", apiKey: resolved.apiKey ?? "none" },
						sessionId,
					),
					// LT-1: the profile's stream watchdog bound, if it states one.
					// NOT an adapter option — an agent-definition field the
					// runtime reads — so it stays here rather than moving into
					// adapterOptionsFor.
					...(resolved.profile.streamIdleMs !== undefined ? { streamIdleMs: resolved.profile.streamIdleMs } : {}),
				}
			: { adapter: createFauxProvider(readFauxScript().slice(fauxSkipTurns)) }),
		// LT-1: KISO_STREAM_IDLE_MS (the test rigs' knob) beats the profile —
		// the last spread wins, which is why it sits after the profile's.
		...(idleFromEnv !== undefined ? { streamIdleMs: idleFromEnv } : {}),
		...(retriesFromEnv !== undefined ? { maxRetries: retriesFromEnv } : {}),
		// ADR-0005 Amendment 2: the kernel announces each retry before its
		// wait; the running row shows it. Composed with every extension's
		// hooks by the runtime — an extension observing retries too is heard.
		hooks: {
			onRetry: async (info) => {
				setRetryShown({ attempt: info.attempt, maxRetries: info.maxRetries, code: info.code, until: Date.now() + info.delayMs });
			},
		},
	};
	return createAgent(definition);
}
