/**
 * The ergonomics batch B4 (pure move) — the ONE dispatcher: slash commands, exit, and
 * turns. The bodies moved verbatim from chat()'s closure; chat provides
 * the context (the chain, the run state, the prompt arming).
 */

import { escapeTerminal, kUnit, palette } from "@vincemakes/kiso-tui";
import { buildAdapter } from "@vincemakes/kiso-runtime/internal";
import type { AgentSession } from "@vincemakes/kiso-runtime";
import { MODES, getMode, setMode } from "./mode.js";
import { agentModel, body, bodyLog, configModels, dock, setAgentModel, setCurrentModelName, type LineInput } from "./state.js";
import { directWriteProfile, profileAvailable } from "./config.js";

/** Everything dispatch touches that chat() owns. */
export interface DispatchCtx {
	readonly session: AgentSession;
	readonly input: LineInput;
	/** the turn chain — every dispatch segment appends onto it (the queue
	 *  replay and the REPL share the chain). */
	readonly chainRef: { current: Promise<void> };
	/** true while a run is in flight — /compact refuses mid-run. */
	readonly isRunning: () => boolean;
	/** the /mode switch repaints the status bar at once. */
	readonly paintIdle: () => void;
	/** submit a real turn: queue + chain (the turn closure lives in chat). */
	readonly submitTurn: (line: string) => void;
	/** the /status context estimate. */
	readonly estimateCtx: () => number;
}

/** The ONE dispatcher — slash commands, exit, and turns. The recovery
 *  replay routes through it too — a queued "/last" must never become a
 *  user turn (v2c: the rl lives in main, so lines arrive earlier and the
 *  queue is the common path). */
export function dispatch(line: string, ctx: DispatchCtx): void {
	const trimmed = line.trim();
	if (trimmed === "/help") {
		// Prints the available commands with one-line descriptions.
		// v2a: the command names are the blue identity accent.
		const p = palette();
		const cmd = (name: string, desc: string): string => `${p.bold}${name}${p.reset}    ${desc}`;
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			bodyLog(cmd("/help", "print this list of commands"));
			bodyLog(cmd("/think", "show the last full thinking block"));
			bodyLog(cmd("/last", "show the most recent tool call's input and output"));
			bodyLog(cmd("/status", "show session id, event count, and context estimate"));
			bodyLog(cmd("/mode", "show the approval tier; /mode <name> switches (manual/default/accept-edits/plan/bypass)"));
			bodyLog(cmd("/model", "list model profiles; /model <name|provider/model> switches"));
			bodyLog(cmd("/compact", "summarize the older conversation to free context"));
			// KC1: the composer's keys ride the SAME bodyLog call (it splits
			// on \n) — the help gains a row, the cli source does not.
			// KC2: the redirect joins the same row for the same reason.
			// KC3: and so does the @ picker — the row is where a gesture is
			// taught, and the row costs nothing.
			bodyLog(`${cmd("exit", "leave the session")}\n${cmd("keys", "enter sends · ctrl+J newline (shift+enter where encoded) · esc stops the run · alt+⏎ stops it and sends this instead · @ files")}`);
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/think") {
		// v2b/v2d: print the last COMPLETE thinking block — the body holds
		// it (the ThinkingCell's fold closes at the block's end).
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const t = body.lastThinking();
			if (t === null) {
				bodyLog("[no thinking yet]");
			} else {
				bodyLog(escapeTerminal(t));
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/last") {
		// B area/v2d: print the FULL input/output of the most recent tool
		// call — the body holds it (the ToolCell's final state). Runs on
		// the chain: after any in-flight turn completes.
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const tool = body.lastTool();
			if (tool === null) {
				bodyLog("[no tool call yet]");
			} else {
				bodyLog(`--- ${tool.name} input ---`);
				bodyLog(escapeTerminal(JSON.stringify(tool.input, null, 2)));
				bodyLog(`--- ${tool.name} output${tool.result.isError ? " (error)" : ""} ---`);
				bodyLog(escapeTerminal(tool.result.content));
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "\x12expand") {
		// W15: the expand key (ctrl+r) — /last aimed at a chosen cell.
		// The TARGET is picked at press time: a LIVE tool cell toggles
		// IMMEDIATELY in place (the compositor owns those rows and
		// redraws them — the approval pause is exactly when the user
		// reads a cut diff, and the key must answer then, never after
		// the run). A COMMITTED cell can never toggle — history is never
		// rewritten (ADR-0046) — so its expanded block and the empty
		// answer queue on the chain like /last: the block lands as new
		// content after any in-flight turn. The sentinel carries the
		// control char so a typed "expand" turn is never intercepted.
		const r = body.expandNext();
		if (r.kind === "toggled") {
			ctx.input.prompt(); // in place — the frame already repainted
			return;
		}
		const land = async (): Promise<void> => {
			if (r.kind === "appended") {
				for (const line of r.lines) bodyLog(line);
			} else if (r.kind === "none") {
				bodyLog("[nothing to expand]");
			}
			ctx.input.prompt();
		};
		ctx.chainRef.current = ctx.chainRef.current.then(land);
		return;
	}
	if (trimmed === "/status") {
		// B area: session id, durable event count, and the ~ context
		// estimate — all read straight from the live session, nothing
		// stored separately. Runs on the chain after any in-flight turn.
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const ctxRatio = ctx.estimateCtx();
			const ctxPct = Number.isFinite(ctxRatio) ? `~${Math.round(ctxRatio * 100)}%` : "~?";
			bodyLog(`session ${ctx.session.id}`);
			bodyLog(`${ctx.session.log.all.length} events`);
			bodyLog(`ctx ${ctxPct}`);
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/mode" || trimmed.startsWith("/mode ")) {
		// Modes: /mode alone prints the current tier + the list;
		// /mode <name> switches — the notice cell leaves the audit
		// line in the body, the status bar repaints at once.
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const m = MODES.find((x) => x === trimmed.slice(5).trim());
			if (trimmed.slice(5).trim() === "") {
				bodyLog(`mode ${getMode()}`);
				bodyLog(`tiers: ${MODES.join(" ")}`);
			} else if (m === undefined) {
				bodyLog(`no such mode: ${trimmed.slice(5).trim()}`);
				bodyLog(`tiers: ${MODES.join(" ")}`);
			} else {
				setMode(m);
				body.notice(`mode → ${m}`);
				ctx.paintIdle();
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/model" || trimmed.startsWith("/model ")) {
		// merge round B: /model lists the profiles (with availability — the
		// config never stores keys, only apiKeyEnv NAMES; an unset env
		// marks the profile unavailable, never a crash) and switches the
		// session's adapter — the NEXT turn uses it (session.setAdapter),
		// the notice cell leaves the audit line in the body.
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const arg = trimmed.slice(6).trim();
			if (arg === "") {
				bodyLog(`model: ${agentModel}`);
				const names = Object.keys(configModels);
				if (names.length === 0) {
					bodyLog("profiles: (none — define models in ~/.kiso/config.json)");
				} else {
					for (const name of names) {
						const p = configModels[name]!;
						bodyLog(
							`  ${name} → ${p.kind}/${p.model} · ${p.apiKeyEnv} ${profileAvailable(p) ? "(available)" : "(unavailable)"}`,
						);
					}
				}
				bodyLog("switch with /model <profile-name|provider/model>");
			} else {
				try {
					const direct = directWriteProfile(arg);
					const profile = direct ?? configModels[arg];
					if (profile === undefined) {
						bodyLog(`no such model profile: ${arg}`);
					} else if (!profileAvailable(profile)) {
						bodyLog(
							`model ${arg}: unavailable — the env var ${profile.apiKeyEnv} is not set (configs never store keys, only the env-var name)`,
						);
					} else {
						const adapter = await buildAdapter(profile.kind, {
							apiKey: process.env[profile.apiKeyEnv] as string,
							...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
						});
						ctx.session.setAdapter(adapter);
						setAgentModel(profile.model);
						setCurrentModelName(arg);
						body.notice(`model → ${arg} (${profile.model}) — takes effect on the next turn`);
					}
				} catch (err) {
					body.notice(`[/model] failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/compact") {
		// /compact (ADR-0044): the older conversation becomes one
		// model summary — an OFF-LOOP call through the session's own
		// adapter, so it must never race a running turn: refused
		// mid-run, with a hint to wait for the turn to end.
		if (ctx.isRunning()) {
			body.notice("[/compact] a turn is running — wait for it to finish");
			return;
		}
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			// W18: the compaction indicator — the whole call runs under
			// a live status row (the INDETERMINATE form: the summary is
			// ONE adapter call, no fraction exists — kiso never invents
			// a percentage), with a REAL cancel: esc aborts the signal,
			// which the runtime observes at every phase boundary.
			const abort = new AbortController();
			let compactCancelled = false;
			const onEscape = (): void => {
				if (abort.signal.aborted) return;
				compactCancelled = true;
				abort.abort();
			};
			ctx.input.onEscape(onEscape);
			let compactStart = 0;
			let compactTimer: ReturnType<typeof setInterval> | null = null;
			// the `as` on the initializer keeps the flow type the full union —
			// onStart fills this during the call, but a closure assignment
			// never re-narrows the outer scope (it would read `never`)
			let compactInfo: { rounds: number; tokens: number } | null = null as { rounds: number; tokens: number } | null;
			// the ctx estimate BEFORE the summarized event lands (the used
			// fraction — the recap's "ctx 91% → 34%" drops after compacting)
			let ctxBefore: number | null = null;
			const compacting = (info: { rounds: number; tokens: number }): void => {
				const text = (elapsed: number): string =>
					`▘ compacting · ${info.rounds} rounds · ~${kUnit(info.tokens)} tokens · ${Math.max(0, elapsed)}s`;
				compactStart = Date.now();
				ctxBefore = Math.round(ctx.estimateCtx() * 100);
				dock.setStatus(text(0), "esc to cancel");
				compactTimer = setInterval(() => {
					dock.setStatus(text(Math.round((Date.now() - compactStart) / 1000)), "esc to cancel");
				}, 1000);
			};
			try {
				const result = await ctx.session.summarize({
					signal: abort.signal,
					onStart: (info) => {
						compactInfo = info;
						compacting(info);
					},
				});
				if (result === null) {
					body.notice("[/compact] nothing to compact — fewer than 5 rounds yet");
				} else {
					// W18: the settled RECAP replaces the bare saved-token
					// notice — it names what actually happened: the covered
					// rounds, the one summary, the savings, the ctx drop
					// (the estimate BEFORE vs AFTER — the same chars/4
					// proxy the status bar shows, marked ~), and the time.
					const ctxAfter = Math.round(ctx.estimateCtx() * 100);
					const elapsed = compactStart > 0 ? ((Date.now() - compactStart) / 1000).toFixed(1) : "?";
					// a non-null result implies onStart ran — the "?" is
					// reachable only at the type level
					body.notice(
						`[/compact] ▞ compacted · ${compactInfo?.rounds ?? "?"} rounds → 1 summary · saved ~${kUnit(result.savedTokens)} · ctx ${ctxBefore ?? "?"}% → ${ctxAfter}% · ${elapsed}s`,
					);
				}
			} catch (err) {
				// Honest failure: nothing was persisted, the session
				// is unchanged (ADR-0044 crash semantics).
				if (compactCancelled) {
					body.notice("[/compact] cancelled — nothing was persisted");
				} else {
					body.notice(`[/compact] failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			} finally {
				if (compactTimer !== null) clearInterval(compactTimer);
				ctx.paintIdle();
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "exit" || trimmed === "") {
		ctx.input.close();
		return;
	}
	// v2c: a turn submitted while another runs waits on the chain — the
	// live count rides the status bar (+N queued).
	ctx.submitTurn(line);
}
