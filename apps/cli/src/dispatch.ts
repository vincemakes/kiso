/**
 * The ergonomics batch B4 (pure move) — the ONE dispatcher: slash commands, exit, and
 * turns. The bodies moved verbatim from chat()'s closure; chat provides
 * the context (the chain, the run state, the prompt arming).
 */

import { contextRows, contextUnavailableRows, displayVerb, escapeTerminal, helpRows, kUnit, modelPickView, palette, type PickResult } from "@vincemakes/kiso-tui";
import { newSessionId } from "./session-id.js";
import { buildAdapter, resolveContinuationScope, resolveReasoning } from "@vincemakes/kiso-runtime/internal";
import type { AgentSession } from "@vincemakes/kiso-runtime";
import { MODES, getMode, setMode } from "./mode.js";
import { agentModel, body, bodyLog, configModels, dock, readContextLedger, sessionsDir, setAgentModel, setCurrentModelName, type LineInput , setLastBinding } from "./state.js";
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
	/** TUI2-R1 (E): the model's context window, as the session is
	 *  configured — the /context ledger's denominator. */
	readonly contextWindow: () => number;
	/** the /resume+/clear mini-spec: end this chat() with a switch to
	 *  another session — main re-enters chat there; the editor survives. */
	readonly requestSwitch: (id: string) => void;
	/** every durable session id (the /resume validation + listing). */
	readonly sessions: () => readonly string[];
	/** the dock's session picker, when one exists (bare /resume). */
	readonly pickSession?: () => Promise<string | null>;
}

/** The ONE dispatcher — slash commands, exit, and turns. The recovery
 *  replay routes through it too — a queued "/last" must never become a
 *  user turn (v2c: the rl lives in main, so lines arrive earlier and the
 *  queue is the common path). */
export function dispatch(line: string, ctx: DispatchCtx): void {
	const trimmed = line.trim();
	if (trimmed === "/help") {
		// KC3.5 slice ⓪ (the extraction): the ROWS moved to the terminal
		// layer's strings module (helpRows — the KC3 §1 pattern: what the
		// human reads is presentation). The FLOW is what stays here, and
		// it is unchanged: print on the chain, then re-prompt. The rows
		// are byte-identical to the eight bodyLog calls they replace —
		// the last one still carries its own \n, so `exit` and `keys`
		// land as two rows from one call (bodyLog splits on \n).
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			// TUI2-R1.5 9 (VD-10): /help is sentences for a human — the keys
			// row in particular is one long line that hard-folded mid-word.
			for (const row of helpRows()) bodyLog(row, "words");
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
				// TUI2-R2pre ④: the SECTION HEADERS say the act ("--- read
				// input ---") on the interactive SCREEN; the two payloads
				// between them are the RAW input JSON and the RAW result
				// content and are byte-identical either way.
				//
				// The dock check is the round's one conditional, and it is
				// deliberate: /last is a single code path serving two
				// surfaces, and the ruling covers the screen while the pipe
				// is a machine-readable log whose bytes other things (the
				// e2e gates, anyone's script) already depend on. Without the
				// dock, this is that log — so it keeps the call's own name.
				const verb = dock.active ? displayVerb(tool.name) : tool.name;
				bodyLog(`--- ${verb} input ---`);
				bodyLog(escapeTerminal(JSON.stringify(tool.input, null, 2)));
				bodyLog(`--- ${verb} output${tool.result.isError ? " (error)" : ""} ---`);
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
	if (trimmed === "/rewrap") {
		// R4 (C4d): re-print the recent PROSE at the CURRENT width, at the
		// bottom. kiso hard-folds every row before committing it (invariant
		// ①), which is what makes the transcript the terminal's own — and
		// is also why the terminal cannot re-wrap it on a resize: there is
		// no soft-wrap flag to reflow. Appending is the one move ADR-0046
		// allows, so this is the whole of what can be offered, and it says
		// so rather than pretending the history changed.
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const r = body.rewrap();
			if (r.lines.length === 0) {
				bodyLog("[/rewrap] no prose to re-wrap yet");
			} else {
				bodyLog(`--- re-wrapped ${r.blocks} block${r.blocks === 1 ? "" : "s"} at the current width (appended — the history above is unchanged) ---`);
				for (const line of r.lines) bodyLog(line);
				if (r.skipped > 0) bodyLog(`--- ${r.skipped} earlier block${r.skipped === 1 ? "" : "s"} not re-wrapped (bounded at two screens) ---`);
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/context") {
		// TUI2-R1 (E): the rent-ledger attribution — where the context went,
		// read from the session's TRACE SIDECAR (the observation file E1/E3
		// already write, per request).
		//
		// THE PURITY GATE IS UNTOUCHED and this is why: the trace surface is
		// an OBSERVATION surface (ADR-0051 §6, ruling R7) and correctness
		// never reads it. /context is a DISPLAY command — nothing it reads
		// reaches a recovery plan, a projection, or a request. The read is
		// best-effort by construction: a missing, partial or unparseable
		// ledger renders the honest fallback, never an error and never a
		// guess. recovery-purity.test.ts's probes are unaffected: the
		// derivation still does zero I/O and still ignores trace-shaped data.
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			const ledger = readContextLedger(ctx.session.id, ctx.contextWindow());
			for (const row of ledger === null
				? contextUnavailableRows("the ledger is written per request — run a turn, then ask again")
				: contextRows(ledger)) {
				bodyLog(row);
			}
			ctx.input.prompt();
		});
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
			let arg = trimmed.slice(6).trim();
			// TUI2-R2 ④ — bare /model PICKS. It used to print a list and a
			// sentence telling you to go and edit a JSON file: everything
			// needed to make it a choice was already on screen, and only the
			// choosing was missing. The panel adds the choosing and nothing
			// else — what a switch MEANS is unchanged below, and the printed
			// list survives verbatim wherever there is no panel to draw (a
			// pipe, a dock-less TTY), because that is a machine-readable
			// surface and this round moves no bytes on one.
			if (arg === "" && dock.active && ctx.input.panelAsk !== undefined) {
				const names = Object.keys(configModels);
				const picked = await new Promise<PickResult | null>((resolve) => {
					ctx.input.panelAsk(
						modelPickView(
							{
								header: `model — current: ${agentModel}`,
								options: names.map((name) => {
									const profile = configModels[name]!;
									const marks = [`profile: ${name}`, ...(profileAvailable(profile) ? [] : ["unavailable"]), ...(profile.model === agentModel ? ["current"] : [])];
									return { label: `${profile.kind}/${profile.model}`, note: marks.join(" · ") };
								}),
								// PH-1a (finding PH-F4): the example must be a syntax
								// directWriteProfile actually ACCEPTS — the old
								// "openai/…" hint failed with "no such model profile"
								// on exactly the fresh-install path that shows it.
								typeHint: names.length === 0 ? "type provider/model directly (e.g. openai-compat/deepseek-reasoner)" : "type provider/model directly",
								// the zero-profile copy is TODAY'S, verbatim: the
								// user who sees it is exactly the user who needs
								// the path spelled out
								...(names.length === 0 ? { emptyNote: "no profiles — define models in ~/.kiso/config.json" } : {}),
							},
							// DC-12 (design §4): a panel WAITING ON A HUMAN says ⏸. The
							// else-branch keeps ▸ — it names the current tier, which is
							// what ▸ means everywhere else.
							ctx.isRunning() ? "⏸ run paused" : `▸ ${getMode()}`,
						),
						(v) => resolve(v.action === "picked" ? v.result : null),
					);
				});
				ctx.paintIdle();
				if (picked === null) {
					ctx.input.prompt();
					return; // esc — nothing switched, nothing said
				}
				arg = "index" in picked ? names[picked.index]! : picked.custom;
			}
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
					// XP-1: /model owns the model PLUS the reasoning selector —
					// an optional second token is the effort, validated
					// against the NATIVE matrix (refused with the levels
					// named; never silently downgraded).
					const [profName = "", effortTok] = arg.split(/\s+/);
					const direct = directWriteProfile(profName);
					const profile = direct ?? configModels[profName];
					if (profile === undefined) {
						bodyLog(`no such model profile: ${profName}`);
					} else if (!profileAvailable(profile)) {
						bodyLog(
							`model ${arg}: unavailable — the env var ${profile.apiKeyEnv} is not set (configs never store keys, only the env-var name)`,
						);
					} else {
						const adapter = await buildAdapter(profile.kind, {
							// PH-1c (PH-F19): a keyless profile = an unauthenticated
							// endpoint — the placeholder satisfies the SDK's ctor.
							apiKey: profile.apiKeyEnv === undefined ? "none" : (process.env[profile.apiKeyEnv] as string),
							...(profile.baseUrl !== undefined ? { baseUrl: profile.baseUrl } : {}),
							...(profile.promptCaching !== undefined ? { promptCaching: profile.promptCaching } : {}),
						});
						// PH-1a (finding PH-F8, P0): the switch is ATOMIC —
						// adapter, model id, and provider route move together.
						// setAdapter alone left the session's frozen config
						// carrying the OLD model, so the status row claimed the
						// new model while every request still sent the old id
						// (and usage canonicalized under the old route).
						// MG-1 (A5): the scope moves WITH the adapter — the same
						// atomic switch PH-F8 demanded, one more passenger.
						const scope = resolveContinuationScope(profile.kind, profile.model, profile.baseUrl);
						let reasoning: import("@vincemakes/kiso-runtime/internal").ReasoningSetting | undefined;
						let refused: string | null = null;
						if (effortTok !== undefined) {
							const candidate = { thinking: "default", effort: effortTok } as import("@vincemakes/kiso-runtime/internal").ReasoningSetting;
							const resolved = resolveReasoning(profile.model, candidate);
							if (resolved.ok) reasoning = candidate;
							else refused = resolved.reason;
						}
						if (refused !== null) {
							// native-only, never a silent downgrade: the switch
							// does NOT happen — the refusal names the levels.
							bodyLog(refused);
						} else {
							const binding = {
								adapter,
								model: profile.model,
								provider: profile.kind,
								...(scope !== undefined ? { scope } : {}),
								...(reasoning !== undefined ? { reasoning } : {}),
							};
							ctx.session.setModelBinding(binding);
							setLastBinding(binding);
							setAgentModel(profile.model);
							setCurrentModelName(arg);
							body.notice(`model → ${profName} (${profile.model}${effortTok !== undefined ? ` · ${effortTok}` : ""}) — takes effect on the next turn`);
						}
					}
				} catch (err) {
					body.notice(`[/model] failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			ctx.input.prompt();
		});
		return;
	}
	if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
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
				// R3a: /compact <focus> — the words after the command steer
				// the summary ("keep the auth details"); bare /compact is
				// byte-identical to the pre-round call.
				const focus = trimmed.slice(8).trim();
				const result = await ctx.session.summarize({
					signal: abort.signal,
					...(focus !== "" ? { focus } : {}),
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
						`[/compact] ✦ compacted · ${compactInfo?.rounds ?? "?"} rounds → 1 summary · saved ~${kUnit(result.savedTokens)} · ctx ${ctxBefore ?? "?"}% → ${ctxAfter}% · ${elapsed}s`,
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
		// PH-1a (finding PH-F11): closing the input MID-RUN killed the very
		// surface a later approval would ask through ("readline was
		// closed", the v2b-era edge). On the DOCKED interactive surface the
		// close now queues on the chain — the run finishes (approvals and
		// all), then the REPL exits. DOCK-GATED on purpose: the pipe path
		// is byte-pinned (a notice there would corrupt machine-read
		// streams), a pipe's "exit" always arrives mid-run, and the
		// approval panel the fix protects only exists on the dock. An idle
		// exit is immediate, byte-for-byte as before, on every surface.
		if (ctx.isRunning() && dock.active) {
			if (trimmed === "exit") body.notice("[exit queued — closing after the current run completes]");
			ctx.chainRef.current = ctx.chainRef.current.then(async () => {
				ctx.input.close();
			});
			return;
		}
		ctx.input.close();
		return;
	}
	if (trimmed === "/clear") {
		// the mini-spec: /clear = a FRESH conversation. The old session
		// stays on disk, resumable — the append-only law does not move;
		// what clears is the CONTEXT, never the history.
		if (ctx.isRunning()) {
			body.notice("[/clear] a run is in flight — let it finish (esc stops it), then clear");
			ctx.input.prompt();
			return;
		}
		ctx.requestSwitch(newSessionId(sessionsDir()));
		return;
	}
	if (trimmed === "/resume" || trimmed.startsWith("/resume ")) {
		// the mini-spec: the in-session door to the durable sessions —
		// /resume <id> switches directly; bare /resume opens the SAME
		// picker `kiso resume` owns (dock), or lists ids (no dock).
		if (ctx.isRunning()) {
			body.notice("[/resume] a run is in flight — let it finish (esc stops it), then switch");
			ctx.input.prompt();
			return;
		}
		const arg = trimmed.slice(7).trim();
		if (arg !== "") {
			// a switch never silently CREATES a session — agent.session()
			// would; the validation is the difference
			if (!ctx.sessions().includes(arg)) {
				ctx.chainRef.current = ctx.chainRef.current.then(async () => {
					bodyLog(`no such session: ${escapeTerminal(arg)} — /resume lists them`);
					ctx.input.prompt();
				});
				return;
			}
			ctx.requestSwitch(arg);
			return;
		}
		const others = ctx.sessions().filter((id) => id !== ctx.session.id);
		if (others.length === 0) {
			ctx.chainRef.current = ctx.chainRef.current.then(async () => {
				bodyLog("no other sessions — /clear starts a fresh one");
				ctx.input.prompt();
			});
			return;
		}
		if (ctx.pickSession !== undefined && dock.active) {
			ctx.chainRef.current = ctx.chainRef.current.then(async () => {
				const picked = await ctx.pickSession!();
				if (picked === null) {
					ctx.input.prompt(); // esc — nothing switched, nothing said
					return;
				}
				ctx.requestSwitch(picked);
			});
			return;
		}
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			for (const id of others) bodyLog(`  ${escapeTerminal(id)}`);
			bodyLog("switch with /resume <id>");
			ctx.input.prompt();
		});
		return;
	}
	// PH-1a (finding PH-F1): an unrecognized slash command is an ERROR,
	// never a turn — the fallthrough used to hand "/clear", "/exit", or a
	// typo to the model, burning a request on text the user meant as a
	// command. A multi-line paste that merely begins with "/" is prose and
	// still submits.
	if (trimmed.startsWith("/") && !trimmed.includes("\n")) {
		ctx.chainRef.current = ctx.chainRef.current.then(async () => {
			bodyLog(`unknown command: ${escapeTerminal(trimmed.split(" ")[0] ?? trimmed)} — /help lists the commands`);
			ctx.input.prompt();
		});
		return;
	}
	// v2c: a turn submitted while another runs waits on the chain — the
	// live count rides the status bar (+N queued).
	ctx.submitTurn(line);
}
