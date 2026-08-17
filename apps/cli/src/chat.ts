/**
 * The ergonomics batch B4 (pure move) — the interactive REPL (chat), the run consumer
 * (consumeRun — the single renderer of a run's event stream), the
 * approval-moment mini-diff, the status spinner, and the context
 * estimates. All bodies moved verbatim from index.ts.
 */

import { readFileSync, statSync } from "node:fs";
import {
	escapeTerminal,
	cacheHitPct,
	idleStatus,
	palette,
	renderEvent,
	renderRecap,
	runningStatus,
	toolTarget,
	STATUS_GLYPHS,
	type PanelArgs,
	type PanelView,
	type RenderInput,
	type RunUsage,
} from "@vincemakes/kiso-tui";
import { editFileDiff, writeFileDiff, type DiffResult } from "@vincemakes/kiso-tui";
import { canonicalTargetPath, shellProgressPath } from "@vincemakes/kiso-tools-node";
import { canonicalizeUsage } from "@vincemakes/kiso-runtime";
import type { AgentSession, Run } from "@vincemakes/kiso-runtime";
import { dispatch, type DispatchCtx } from "./dispatch.js";
import { agentModel, body, bodyLog, configuredWindow, dock, type LineInput } from "./state.js";
import { addDontAskAgainRule, askPanel, fixHintFor, pendingAsk, resolveUncertains } from "./trust-ui.js";
import { FauxExhaustionError, failOnFauxExhaustion } from "./faux-glue.js";
import { MODES, getMode, setMode } from "./mode.js";

/** B area: default context window for the ~ctx estimate (config overridable). */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * The ergonomics batch C8 — the /compact auto-trigger, OPT-IN (default off: only an
 * explicit KISO_AUTO_COMPACT=<ratio> enables it — the CLI never defaults
 * it on). After every completed turn the ~ctx ratio is checked; at/over
 * thresholdRatio the /compact full path runs (the same dispatch — same
 * notices, same chain ordering, same mid-run refusal).
 */
export interface AutoCompact {
	/** 0 < r < 1 — the ~ctx ratio that triggers the compaction. */
	readonly thresholdRatio: number;
}

/** Parse KISO_AUTO_COMPACT — an invalid value is OFF, never a crash. */
export function autoCompactFromEnv(): AutoCompact | undefined {
	const raw = process.env.KISO_AUTO_COMPACT;
	if (raw === undefined) return undefined;
	const ratio = Number.parseFloat(raw);
	if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return undefined;
	return { thresholdRatio: ratio };
}

/**
 * C area: the model window in tokens — env (KISO_CONTEXT_WINDOW) beats the
 * config window (merge round B), both beat the 200k default. The microcompact
 * threshold is derived from it (50%), and the status line's ~ctx estimate
 * is measured against it — one source of truth for the window.
 */
export function contextWindowTokens(): number {
	const windowOverride = configuredWindow;
	if (windowOverride !== undefined) return windowOverride;
	const window = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	return Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
}

/**
 * B area: approximate context ratio — chars/4 of the projected messages vs
 * the model window. Marked ~ everywhere it is shown; no counting API.
 */
export function estimateCtxRatio(session: AgentSession): number {
	const projected = session.projected();
	const chars = JSON.stringify(projected).length;
	return chars / 4 / contextWindowTokens();
}

/** R-C item 4: the per-turn cache miss — the overlap with the previous
 *  prompt that SHOULD have been cached but was re-sent uncached:
 *  missed = min(prevIn, in) − cacheRead. Below the 1024-token floor
 *  (Anthropic's minimum cacheable block) it is noise — not surfaced. */
const CACHE_MISS_FLOOR = 1024;

/** E2 (1.3.0) — the CLI's usage consumer: one event in, the RunUsage the
 *  status line and recap render plus the miss estimate. `total` is the
 *  carrier for the NEXT turn's miss estimate — the overlap of consecutive
 *  prompts is a total-side quantity, never a fresh delta. */
export interface UsageDelta {
	readonly usage: RunUsage;
	/** The canonical total (fresh + cache) — the miss estimate's carrier.
	 *  null when the event carried no usage (the canonical total of an
	 *  unknown event is 0, and a 0 carrier keeps the estimate below the
	 *  floor — the old consumer's carrier stayed null forever; this one
	 *  recovers on the next known event). */
	readonly total: number | null;
	readonly missed: number | null;
	/** TUI2-R1 (E): the CANONICAL cost of this request — null when the
	 *  pricing table has no rate for the route (the R5b-④c absent stamp).
	 *  Null is carried, never zeroed: a missing rate is not a free call. */
	readonly costUsd: number | null;
}

/**
 * The CLI's usage consumer (E2 1.3.0, the R2a-1 ruling 2026-08-13) — the
 * HEAL: the mixed-convention consumer is now CANONICAL at the route (the
 * accounting boundary), the same derivation the trace block carries.
 *
 * EXISTING-BEHAVIOR CHANGE — declared, never a silent side-fix:
 *  - openai-compat: `in` was the provider-raw TOTAL (fresh + cache); it is
 *    now the canonical FRESH count. The >100% cache-ratio disease: raw
 *    {input 111, cacheRead 1024} previously rendered "in 111" and the
 *    recap's cache % (then cache/in) read 923%; now "in 0" and the recap
 *    divides cache by the TOTAL (in + cache — T5) — never > 100%.
 *  - the miss estimate is numerically IDENTICAL on openai-compat: its old
 *    `in` WAS the total, and the carrier is the canonical total
 *    (input + cacheRead), which equals the raw total by construction.
 *  - anthropic: `in` was already fresh — unchanged; the miss estimate was
 *    min-of-fresh-deltas − cacheRead (always below the floor — silent);
 *    it is now min-of-totals, the semantics the openai-compat side always
 *    had (a fix, and it can fire).
 *  - the unknown-usage carrier: the old consumer's null carrier killed the
 *    miss signal forever; the canonical total of an unknown event is 0, so
 *    the signal recovers on the next known event.
 * The route key mirrors the trace path's fallback by construction: an
 * absent provider resolves like the tracer's "adapter" identity — the
 * total convention (INPUT_CONVENTIONS), never a crash.
 */
export function usageFromEvent(
	route: string | undefined,
	ev: import("@vincemakes/kiso-core").Usage,
	prevTotal: number | null,
): UsageDelta {
	const c = canonicalizeUsage(route ?? "adapter", ev);
	const total = c.input + c.cacheRead + (c.cacheWrite ?? 0);
	let missed: number | null = null;
	// R-C item 4: min(prevTotal, total) is the part that could have been
	// cached; what cacheRead did NOT cover is the miss. A below-floor or
	// non-positive difference is noise — not surfaced.
	if (prevTotal !== null) {
		const m = Math.min(prevTotal, total) - c.cacheRead;
		missed = m > CACHE_MISS_FLOOR ? m : null;
	}
	return { usage: { in: c.input, out: c.output, cache: c.cacheRead, known: ev.known }, total, missed, costUsd: c.costUsd };
}

/** v2b: the spinner merged into the STATUS BAR (the v2a standalone glyph
 *  is gone) — docked only, 200ms rotation between the request and the
 *  first event. */
export function startStatusSpinner(onTick: (glyph: string) => void): () => void {
	if (!dock.active) return () => {};
	// v3 §03/§05: the working glyph family ▖▘▝▗, 200ms rotation — the
	// callback repaints the running status line with the new glyph.
	// KC2 §5: the family itself moved to the tui's status formatters.
	let i = 0;
	const timer = setInterval(() => onTick(STATUS_GLYPHS[i++ % STATUS_GLYPHS.length]!), 200);
	timer.unref();
	return () => clearInterval(timer);
}

/**
 * TUI2-R1 (C) — the shell tailer: the READER half of the progress
 * sidecar (the writer is the shell tool, tools-node).
 *
 * The CLI is the only place that holds both facts the derived key needs
 * — the session's id and the running call's command — so the tail is
 * read here and handed to the cell. A poll, not a watcher: fs.watch's
 * behaviour on a file being appended to differs by platform, and the
 * one thing this must never do is misbehave in a way that costs the run.
 *
 * THE FRESHNESS GUARD is the part that makes a kill -9 leftover
 * harmless. A sidecar the writer never got to remove keeps its old
 * mtime; a tail is read only from a file modified AT OR AFTER the call
 * started. A ghost from a previous process cannot be shown as this
 * call's output — and since the tail is display-only, showing nothing is
 * always the safe answer.
 */
const TAIL_POLL_MS = 250;
const TAIL_BYTES = 4096; // the last lines are all the window can hold

export function startShellTail(sessionId: string, callId: string, command: string, startedAt: number): () => void {
	const path = shellProgressPath(sessionId, command);
	const read = (): void => {
		try {
			const stat = statSync(path);
			if (stat.mtimeMs + 1000 < startedAt) return; // a ghost from a killed run — never this call's
			const text = readFileSync(path, "utf8");
			body.toolProgress(callId, text.slice(-TAIL_BYTES).trimEnd());
		} catch {
			// no sidecar yet, removed at settle, or unreadable — the tail
			// is an observation, and its absence is never an error
		}
	};
	read();
	const timer = setInterval(read, TAIL_POLL_MS);
	timer.unref();
	return () => clearInterval(timer);
}

/** v2e: the approval-moment mini-diff — edit_file/write_file changes as
 *  ± lines; other tools get null (no diff, no cost). The file read is
 *  best-effort: an unreadable file yields NO diff, never a failure —
 *  the diff must never break the approval. */
function approvalDiff(name: string, input: Record<string, unknown>): DiffResult | null {
	if (name !== "edit_file" && name !== "write_file") return null;
	const path = typeof input.path === "string" ? input.path : "";
	if (path === "") return null;
	let oldContent: string | null = null;
	try {
		oldContent = readFileSync(path, "utf8");
	} catch {
		// a new write_file target (or an unreadable one) — all + degrades
	}
	try {
		if (name === "edit_file") {
			const search = typeof input.search === "string" ? input.search : "";
			const replace = typeof input.replace === "string" ? input.replace : "";
			if (search === "") return null;
			// TUI2-R1.5 ② (VD-2): the path rides along so a miss can name the
			// file in its honest note instead of fabricating a diff.
			return editFileDiff(oldContent ?? "", search, replace, path);
		}
		const content = typeof input.content === "string" ? input.content : "";
		return writeFileDiff(oldContent, content);
	} catch {
		return null; // never let the diff break the approval
	}
}

/** W21 — the panel view for a permission_requested: the rule line (the
 *  why-asked speaker + the §3.5 fix hint), the toolTarget title, the
 *  "▸ run paused" status, and the ALWAYS-verbose args. */
function approvalView(name: string, ev: { speaker?: string; input?: Record<string, unknown> }): PanelView {
	const speaker = ev.speaker ?? "kiso";
	const input = ev.input ?? {};
	// exactOptionalPropertyTypes: the hint is OMITTED when the speaker has
	// no fix (mode:accept-edits, shell in default) — never `hint: undefined`.
	const hint = fixHintFor(speaker, name);
	return {
		flavor: "approval",
		name,
		title: toolTarget(name, input),
		speaker,
		...(hint !== undefined ? { hint } : {}),
		statusText: "▸ run paused",
		args: approvalArgs(name, input),
		fallbackQuestion: `approve ${escapeTerminal(name)}? (y/n) `,
	};
}

/** The panel's ALWAYS-verbose args: edit_file/write_file → the full ±
 *  diff (the tool cell's capped copy never reaches the panel — the
 *  human approves the WHOLE change), shell → the full command line,
 *  anything else → the pretty-printed JSON. Nothing that is asked for
 *  approval is ever truncated. */
function approvalArgs(name: string, input: Record<string, unknown>): PanelArgs {
	if (name === "edit_file" || name === "write_file") {
		return { kind: "diff", diff: approvalDiff(name, input)?.lines ?? null };
	}
	if (name === "shell") {
		return { kind: "text", lines: [String(input.command ?? "")] };
	}
	return { kind: "text", lines: JSON.stringify(input, null, 2).split("\n") };
}

/**
 * The ergonomics batch C5 — the translation layer: the tui renders its OWN data shape
 * (RenderInput, zero kiso-core imports); the CLI translates its Event
 * stream here. Events without a render (stop, expired, resolved, …) → null,
 * and the consumer skips them — the pipe bytes stay identical.
 */

/**
 * round 6 (the task round): translate a do-not-compact-tagged tool result whose
 * content follows the task echo contract (a [task] header line + one
 * `[pending|active|done] text` line per item) into the checklist cell's
 * structured items. Null = not a checklist — the ordinary result cell
 * renders. Keyed on the TAG (what the extension declared), never on a
 * tool name; the parse is graceful so a foreign tagged result still
 * renders normally.
 */
function parseChecklist(
	tags: readonly string[] | undefined,
	content: string,
): { header: string; items: { text: string; status: "pending" | "active" | "done" }[] } | null {
	if (!(tags ?? []).includes("do-not-compact")) return null;
	const items: { text: string; status: "pending" | "active" | "done" }[] = [];
	let header = "";
	for (const line of content.split("\n")) {
		const head = /^\[task\] (.*)$/.exec(line);
		if (head !== null) {
			header = head[1]!;
			continue;
		}
		const m = /^\[(pending|active|done)\] (.*)$/.exec(line);
		if (m !== null) items.push({ text: m[2]!, status: m[1] as "pending" | "active" | "done" });
	}
	if (items.length === 0) return null;
	return { header, items };
}

function toRenderInput(ev: import("@vincemakes/kiso-core").Event): RenderInput | null {
	switch (ev.type) {
		case "user_input":
			return { type: "user_input", content: ev.content };
		case "text_delta":
			return { type: "text_delta", text: ev.text };
		case "text_end":
			return { type: "text_end" };
		case "thinking":
			return { type: "thinking", text: ev.text };
		case "tool_call_end":
			return { type: "tool_call_end", name: ev.name, input: ev.input };
		case "tool_execution_started":
			return { type: "tool_execution_started" };
		case "tool_execution_succeeded":
			return { type: "tool_execution_succeeded" };
		case "tool_execution_failed":
			return { type: "tool_execution_failed", error: ev.error };
		case "tool_result":
			return { type: "tool_result", content: ev.content, isError: ev.isError };
		case "permission_requested":
			return { type: "permission_requested", name: ev.name, input: ev.input };
		case "permission_decided":
			return { type: "permission_decided", decision: ev.decision, ...(ev.reason !== undefined ? { reason: ev.reason } : {}) };
		case "terminal":
			return { type: "terminal", outcome: ev.outcome };
		case "compacted":
			return { type: "compacted", cleared: ev.cleared };
		case "summarized":
			return { type: "summarized", coversToSeq: ev.coversToSeq };
		case "uncertain_pending":
			return { type: "uncertain_pending", name: ev.name, executionId: ev.executionId, error: ev.error };
		default:
			return null; // events without a render (stop, expired, resolved, …)
	}
}

/**
 * Consume a run, answering approval pauses as they arrive. `resumeMode`
 * marks a session.resume() continuation. `faux` picks the status line's
 * form. W22: EVERY user_input event renders its UserMessage chip in the
 * body — the v2a double-echo filter is retired (the transient input-row
 * echo is UI, the chip is the record; the momentary double-render is
 * the design's explicit point).
 */
export async function consumeRun(
	session: AgentSession,
	run: Run,
	input: LineInput,
	turnNo: number,
	faux: boolean,
	statusCb: ((usage: RunUsage, ctxRatio: number, costUsd?: number | null) => void) | null,
	/** W21: the amend words ("Yes + feedback") ride the NEXT user turn —
	 *  threaded from chat's submitTurn; absent in the recovery flow
	 *  (resume) where a dropped amend is noticed instead. */
	submitTurn?: (line: string) => void,
): Promise<import("@vincemakes/kiso-core").Event | undefined> {
	let last: import("@vincemakes/kiso-core").Event | undefined;
	let usage: RunUsage = { in: null, out: null, cache: null, known: false };
	let prevTotal: number | null = null;
	let missed: number | null = null;
	// v3 §02: the recap line derives ENTIRELY from the local event stream
	// (zero tokens) — wall seconds, tool/edit counts, usage, ctx left.
	const turnStart = Date.now();
	let toolCount = 0;
	let editCount = 0;
	// W14: the thinking event carries NO timestamp — the CLI wall-clocks
	// the thinking window: it opens at the first thinking event and closes
	// at the first non-thinking event (the fold needs the seconds).
	let thoughtSeconds = 0;
	let thinkingSince: number | null = null;
	// TUI2-R1 (C): the shell commands seen this run, and the tailers
	// running for them. A tailer is started when the execution starts and
	// stopped at the call's result — and the finally below stops any that
	// an abort left behind, so a poller can never outlive its run.
	const shellCommands = new Map<string, string>();
	const tailers = new Map<string, () => void>();
	const stopTail = (callId: string): void => {
		tailers.get(callId)?.();
		tailers.delete(callId);
	};
	try {
	for await (const ev of run) {
		last = ev;
		if (ev.type !== "thinking") {
			if (thinkingSince !== null) {
				thoughtSeconds += (Date.now() - thinkingSince) / 1000;
				thinkingSince = null;
			}
		} else if (thinkingSince === null) {
			thinkingSince = Date.now();
		}
		// v2d: EVERY event only mutates a cell — the Body is the single
		// writer of the scroll region, so interleaving is impossible by
		// construction (ADR-0040).
		switch (ev.type) {
			case "user_input":
				body.userLine(typeof ev.content === "string" ? ev.content : "");
				break;
			case "thinking":
				body.thinkingAppend(ev.text);
				break;
			case "tool_call_end":
				toolCount += 1;
				if (ev.name === "edit_file") editCount += 1;
				body.toolStart(ev.name, ev.callId, ev.input ?? {});
				// TUI2-R1 (C): the command is the sidecar key's other half —
				// remembered here, used when the execution actually starts.
				if (ev.name === "shell" && typeof ev.input?.command === "string") shellCommands.set(ev.callId, ev.input.command);
				break;
			case "tool_execution_started": {
				body.toolRunning(ev.callId);
				const command = shellCommands.get(ev.callId);
				if (command !== undefined) tailers.set(ev.callId, startShellTail(session.id, ev.callId, command, Date.now()));
				break;
			}
			case "tool_execution_succeeded":
				body.toolSucceeded(ev.callId);
				break;
			case "tool_execution_failed":
				body.toolFailed(ev.callId, ev.error);
				break;
			case "tool_result": {
				// TUI2-R1 (C): the observation window closes the instant the
				// real result exists — the tail must never race it.
				stopTail(ev.callId);
				const text = typeof ev.content === "string" ? ev.content : "";
				// W19: a DENIED call carries its reason — extracted from the
				// result's "[Permission denied] " prefix, keyed on the
				// "denied" tag (the parseChecklist discipline: the tag
				// declares, the prefix confirms). The ToolCell renders the
				// pinned row (full name, target, reason, no timing).
				let reason: string | null = null;
				if ((ev.tags ?? []).includes("denied")) {
					const m = /^\[Permission denied\] (.*)$/.exec(text);
					if (m !== null) reason = m[1]!;
				}
				body.toolResult(ev.callId, { content: text, isError: ev.isError, reason });
				// round 6 (the task round): a result tagged do-not-compact whose content
				// follows the checklist shape also renders as the durable
				// checklist cell (the CLI translates Event → the tui's own
				// shape; a non-matching parse falls back to the ordinary
				// result cell — never hide information).
				const checklist = parseChecklist(ev.tags, text);
				if (checklist !== null) body.checklist(checklist.header, checklist.items);
				break;
			}
			case "text_delta":
				body.textAppend(ev.text);
				break;
			case "text_end":
				body.textEnd();
				break;
			case "usage": {
				const delta = usageFromEvent(session.provider, ev, prevTotal);
				usage = delta.usage;
				prevTotal = delta.total;
				missed = delta.missed;
				// TUI2-R1 (E): the request's canonical cost rides the same
				// callback the usage does — one settled request, one addition.
				statusCb?.(usage, estimateCtxRatio(session), delta.costUsd);
				break;
			}
			case "uncertain_pending":
				// ruling #12 (ADR-0038): the ⚠ line is pure INFORMATION now — the
				// approval chain guards retries, and the human question belongs
				// only to the crash window's recovery flow (resolveUncertains).
				body.notice(`⚠ ${escapeTerminal(ev.name)} FAILED — the side effect may have applied. ${escapeTerminal(ev.error)}`);
				break;
			case "permission_requested": {
				// v2d: the ToolCell shows the ⏸ badge; the question takes over
				// the dock status position; the answer lands at the input line.
				// v2e: the mini-diff for edit/write at the approval moment —
				// the human sees the change BEFORE deciding (auto-allowed tools
				// skip the diff: nobody is looking).
				// W21: the PANEL replaces the line question — the bounded block
				// with the ALWAYS-verbose args (the full diff / command / JSON,
				// nothing the human approves is ever cut) and the numbered
				// options. The verdict maps to the session approvals:
				//  - bare No   → approve(false) FIRST (the denial settles the
				//    request), THEN run.abort() — the run's aborted terminal
				//    closes the cell;
				//  - No+words  → approve(false, words) — the words become the
				//    tool_result, the run continues;
				//  - Yes+amend → approve(true), the words ride the NEXT turn;
				//  - esc       → cancel, the conservative denial.
				const name = (ev as { name: string }).name;
				body.toolApproval(ev.callId, approvalDiff(name, ev.input ?? {}));
				const decisionId = (ev as { decisionId: string }).decisionId;
				const verdict = await askPanel(input, approvalView(name, ev as { speaker?: string; input?: Record<string, unknown> }));
				switch (verdict.action) {
					case "cancel": {
						// round 10: a cancellation is a CONSERVATIVE denial,
						// explicitly distinguished from the user typing "n".
						body.notice("[approval cancelled — treated as a denial]");
						await session.approve(decisionId, false);
						break;
					}
					case "allow": {
						await session.approve(decisionId, true);
						if (verdict.reason.trim() !== "") {
							if (submitTurn !== undefined) submitTurn(verdict.reason);
							else body.notice("[amend words dropped — the recovery flow has no live prompt]");
						}
						break;
					}
					case "allow-rule": {
						// R3: the don't-ask-again extension is ALLOW-ONLY (never
						// emits deny or ask — the mode and safe-defaults moats
						// keep their teeth); the generated file is human-editable
						// and human-deletable — that IS the revocation path.
						await session.approve(decisionId, true);
						await addDontAskAgainRule(verdict.rule);
						break;
					}
					case "deny": {
						if (verdict.reason.trim() !== "") {
							// No+words — the words become the tool_result; the
							// run continues with the model seeing the denial.
							await session.approve(decisionId, false, verdict.reason);
						} else {
							// bare No — the denial settles the pause FIRST, then
							// the run aborts.
							await session.approve(decisionId, false);
							run.abort();
						}
						break;
					}
				}
				break;
			}
			case "permission_decided": {
				// A5: the verdict binds INTO the tool cell — the aggregated
				// head row (name + status + decidedBy in ONE row), never a
				// free-standing `  approved` orphan. The render.ts case stays
				// for the PIPE path (the transcript is the raw event stream).
				body.toolVerdict(ev.callId ?? "", ev.decision, ev.decidedBy, ev.reason);
				break;
			}
			case "terminal": {
				// v3 §02: the run's recap line REPLACES the old "done" label
				// + status line — one local line, derived from this run's
				// events (zero tokens). The dock's status bar still paints.
				statusCb?.(usage, estimateCtxRatio(session));
				const ratio = estimateCtxRatio(session);
				// W14: the turn record closes HERE — before the recap logs, so
				// the commit loop folds the quiet turn's held cells first (the
				// fold line lands above the recap, natural cell order).
				body.endTurn(Math.round(thoughtSeconds));
				// D4: the max_tokens truncation is named, never silent — the
				// honest notice rides after the partial answer, before the
				// recap (the truncation-guard philosophy: the cut is visible
				// in the scrollback, the model's own text intact).
				if (ev.outcome.kind === "max_tokens") {
					body.notice('┌ answer truncated at max_tokens — say "continue" to finish');
				}
				bodyLog(
					renderRecap({
						seconds: Math.round((Date.now() - turnStart) / 1000),
						tools: toolCount,
						edits: editCount,
						usage,
						// R-C item 4: only an above-floor miss is surfaced —
						// the recap gains "· miss N" on the cache segment.
						...(missed !== null ? { missed } : {}),
						ctxLeftPct: Number.isFinite(ratio) ? (1 - ratio) * 100 : null,
						// W19: under plan the recap becomes the way-forward row
						// (the /mode hints are the mode's exits).
						mode: getMode(),
					}),
				);
				break;
			}
			default: {
				// Events without a cell (stop, …) — the generic render, byte-
				// preserved for the pipe path (C5: Event → RenderInput first).
				const input = toRenderInput(ev);
				if (input === null) break;
				const rendered = renderEvent(input, false, canonicalTargetPath);
				if (rendered.text !== "") {
					body.raw(rendered.text.replace(/\n$/, "").split("\n"));
				}
				break;
			}
		}
	}
	body.thinkingEnd(); // a trailing thinking block folds at the run's end
	} finally {
		// TUI2-R1 (C): an abort or a throw leaves the loop without a
		// tool_result — every tailer stops here regardless, so no poller
		// outlives the run that started it.
		for (const callId of [...tailers.keys()]) stopTail(callId);
	}
	return last;
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
export async function chat(session: AgentSession, faux: boolean, input: LineInput, autoCompact?: AutoCompact): Promise<void> {
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;
	// E group (the graceful-exit gate ③, R-G 0.1.48): the terminal can
	// close MID-run — the stream 'end' fires while currentRun is set, so
	// the EOT callback defers. eotSeen remembers it; each run's end
	// re-evaluates the exit condition (the safe point), so the release
	// always runs.
	let eotSeen = false;
	/** The exit condition, shared by the EOT callback and the deferred
	 *  re-check: no pending ask, an empty line. currentRun is checked by
	 *  the callers (the callback when 'end' fires; the run-end re-checks
	 *  run only after currentRun was nulled). */
	const exitAtEmptyPrompt = (): void => {
		if (pendingAsk !== null || input.line() !== "") return;
		cancelled = true;
		console.log("\n[exit requested]");
		input.close();
	};

	const turn = (text: string): Promise<void> =>
		new Promise((resolve, reject) => {
			queued = Math.max(0, queued - 1); // a queued turn starts
			const run = session.run(text);
			currentRun = run;
			turnNo += 1;
			const myTurn = turnNo;
			// v3 §03: the running state owns the status bar — the glyph
			// rotates every 200ms; the idle state returns after the run.
			runStart = Date.now();
			runUsage = { in: null, out: null, cache: null, known: false };
			const stopSpinner = startStatusSpinner((g) => {
				runGlyph = g;
				paintRunning();
			});
			(async () => {
				let last: import("@vincemakes/kiso-core").Event | undefined;
				try {
					last = await consumeRun(session, run, input, myTurn, faux, statusCb, submitTurn);
					stopSpinner();
					paintIdle();
					currentRun = null;
					// round 8: a faux script that ran out of declared turns exits
					// loudly with a non-zero status — never a silent status 0.
					// round 4 (adversarial): the exhaustion is a CONTROLLED rejection of
					// this turn's promise — it propagates through the chain to
					// chat to main's finally/catch, never an orphaned
					// unhandled rejection from the IIFE.
					failOnFauxExhaustion(last, faux, input);
					// E group (the graceful-exit gate ③): the fd may have closed
					// mid-run — the run's end is the safe point for the deferred
					// exit, so the release always runs.
					if (eotSeen) exitAtEmptyPrompt();
					// round 8: after EVERY turn the prompt is re-armed — the human
					// never types blind after the first turn.
					input.prompt();
					// the ergonomics batch C8: the opt-in auto-compact — checked AFTER the
					// turn ended (the run's terminal is in the log, the ratio
					// is post-run).
					await maybeAutoCompact();
					resolve();
				} catch (err) {
					// A run failure must not freeze the REPL (review finding
					// 11): surface it and re-arm the prompt.
					if (err instanceof FauxExhaustionError) {
						currentRun = null;
						reject(err);
						return;
					}
					console.error(`\n[run failed] ${err instanceof Error ? err.message : String(err)}\n`);
					currentRun = null;
					input.prompt();
					resolve();
				}
			})();
		});

	input.onSigint(() => {
		if (currentRun) {
			// round 8: Ctrl+C cancels BOTH the pending question (if one is
			// awaiting a line) and the run — the run then writes its unique
			// aborted terminal, which the consumer keeps consuming.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (pendingAsk !== null) {
			pendingAsk?.(); // a startup/trust question — cancel it
		} else if (input.line() === "") {
			cancelled = true;
			console.log("\n[exit requested]");
			input.close();
		} else {
			input.clearLine(); // v2c: Ctrl+C on a non-empty line clears it
		}
	});
	input.onEot(() => {
		// E group (the graceful-exit gate ③): the 'end' may fire MID-run —
		// the exit defers to the run's end (the re-checks below).
		eotSeen = true;
		if (!currentRun) exitAtEmptyPrompt();
	});
	input.onEscape(() => {
		if (currentRun) {
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		}
	});
	// KC2 §2/§3 — the redirect: "stop, and do THIS instead". No stream
	// injection, no new durable or op state — the run aborts (its terminal
	// is an honest `aborted`) and the buffer's text becomes the next turn.
	// With no run in flight the gesture is simply an Enter, which is what
	// the human means by it: there is nothing to stop.
	input.onRedirect?.((line) => {
		if (currentRun === null) return dispatch(line, dispatchCtx);
		console.log("\n[redirecting run]");
		pendingAsk?.();
		currentRun.abort();
		// §3: a correction must run BEFORE the follow-ups queued earlier —
		// it is a correction OF them. The existing slot mechanics compose
		// it: every pending slot leaves through the SAME pop the ↑ key uses
		// (cancelled, so its chain segment skips), then they re-enter
		// BEHIND the correction, in their original order. Ephemeral
		// reordering of ephemeral state; the durable log still just records
		// what ran, in the order it ran.
		const jumped = pendingTurns.map((s) => s.line);
		for (let i = jumped.length; i > 0; i -= 1) popQueue();
		for (const text of [line, ...jumped]) submitTurn(text);
	});

	// round 5 (P1-11): the PERSISTENT line listener is installed BEFORE the
	// startup recovery — a cancelled question's re-emitted "line" needs a
	// listener from the very first instant, or the input is silently lost.
	// Turns are SERIALIZED on a chain — piped lines arrive faster than
	// turns complete, and concurrent runs are forbidden. Lines that arrive
	// while the recovery is still running are QUEUED and replayed once the
	// REPL is ready (they are never dropped).
	const chainRef: { current: Promise<void> } = { current: Promise.resolve() };
	let replReady = false;
	const queuedLines: string[] = [];
	// B area: user-turn counter for the status line. /last and /think read
	// the body (the ToolCell / ThinkingCell final states).
	let turnNo = 0;
	// v2c: turns submitted while another runs are QUEUED on the chain —
	// the live count rides the status bar (+N queued).
	let queued = 0;
	// W22: the pending turns — the LIVE slots the chips + the ↑/esc pop
	// read (the dock renders the lines, the editor pops the last one).
	// A slot leaves the queue when its turn STARTS or when the user
	// pops it (cancelled — the chain segment skips it).
	const pendingTurns: { line: string; cancelled: boolean }[] = [];
	// v2b: the live status bar (docked only). Modes: /mode switches repaint
	// it immediately through paintStatus (the last turn stats are kept).
	// v3 §03: the status bar has TWO states. Idle: the mode is ALWAYS
	// shown (default included) with the /mode hint. Running: the working
	// glyph (▖▘▝▗ — the spinner drives it) + wall seconds + ↓ out tokens
	// + the interrupt hint. ctx left is the live estimate everywhere.
	let runUsage: RunUsage = { in: null, out: null, cache: null, known: false };
	// TUI2-R1 (E): the session's spend so far — the CANONICAL cost of every
	// request this process has seen, summed. Null stays null: a route with
	// no rate in the pricing table contributes nothing and the row shows no
	// $ at all, because a partial total presented as a total is a lie.
	let spentUsd: number | null = null;
	let runGlyph = "▖";
	let runStart = Date.now();
	// KC2 §5: the STATE (the glyph, the run's start, the usage, the dock)
	// stays here; the ROW's text is the tui's status formatter.
	const paintRunning = (): void => {
		if (dock.active) dock.setStatus(runningStatus(runGlyph, runStart, runUsage.out, estimateCtxRatio(session)));
	};
	// W19: under plan the idle row makes the posture unmistakable — the W4
	// parentheses idiom names the read-only constraint. The tier is the
	// CALLER's word (the recovery flow passes the bare mode).
	const paintIdle = (): void => {
		if (!dock.active) return;
		// TUI2-R1 (E): the meter rides the idle row — both fields omitted
		// when unknown, so a session that has not called the model paints
		// exactly the pre-round row.
		dock.setStatus(
			idleStatus(getMode() === "plan" ? "plan (read-only)" : getMode(), agentModel, estimateCtxRatio(session), {
				cacheHitPct: cacheHitPct(runUsage),
				costUsd: spentUsd,
			}),
		);
	};
	const statusCb = (u: RunUsage, ctx: number, costUsd?: number | null): void => {
		runUsage = u;
		addCost(costUsd ?? null);
		paintRunning();
	};
	// TUI2-R1 (E): the canonical cost of one settled request, added to the
	// session's running total. A null cost (no rate for the route) adds
	// nothing and leaves the total as it was.
	const addCost = (usd: number | null): void => {
		if (usd === null) return;
		spentUsd = (spentUsd ?? 0) + usd;
	};
	const submitTurn = (line: string): void => {
		const slot = { line, cancelled: false };
		pendingTurns.push(slot);
		queued += 1;
		chainRef.current = chainRef.current.then(async () => {
			if (slot.cancelled) return; // the pop already dropped it — no double count
			const idx = pendingTurns.indexOf(slot);
			if (idx >= 0) pendingTurns.splice(idx, 1); // the chip leaves when the turn STARTS
			// KC2 §4 — the FRESH-TURN uncertainty gate. The runtime's fresh
			// path checks only the open-run gate before persisting
			// user_input (ResumeBlockedError guards the RESUME derivation
			// alone), and the CLI resolved uncertains at startup recovery
			// only — so a turn queued behind an abort-mid-tool could reach
			// the model before the human said whether the side effect
			// applied. It asks HERE, before the turn starts, with the same
			// recovery UI; a human who declines leaves it uncertain and the
			// turn does not start. The resolution's own model-facing fill
			// also answers the dangling tool_use, so the next request never
			// carries an unanswered call. Composed from existing APIs: zero
			// core lines, zero runtime lines.
			if (session.uncertainExecutions().length > 0) await resolveUncertains(session, input, () => cancelled);
			if (session.uncertainExecutions().length === 0) return turn(line);
			// The human declined (round 10: a cancelled ask records NOTHING —
			// the execution stays uncertain and durable), so the turn does not
			// start. It is never swallowed in silence: the held text is
			// printed back, so the human can see what is waiting on them.
			queued = Math.max(0, queued - 1);
			body.notice(`[turn held — the interrupted execution is still undecided] ${escapeTerminal(line)}`);
		});
	};
	// W22: the ↑/esc pop — the LAST queued slot leaves the queue
	// (cancelled + spliced + counted down); null when the queue is
	// empty. The chain segment skips the cancelled slot, so the popped
	// message NEVER runs — it returns to the editor instead.
	const popQueue = (): string | null => {
		const slot = pendingTurns[pendingTurns.length - 1];
		if (slot === undefined) return null;
		slot.cancelled = true;
		pendingTurns.pop();
		queued = Math.max(0, queued - 1);
		return slot.line;
	};
	// W22: the visibility invariant's binds — the dock renders the
	// pending chips (+N queued), the editor routes the pop keys.
	dock.bindQueue(() => pendingTurns.map((s) => s.line));
	input.bindQueue(() => pendingTurns.map((s) => s.line), popQueue);
	const dispatchCtx: DispatchCtx = {
		session,
		input,
		chainRef,
		isRunning: () => currentRun !== null,
		paintIdle,
		submitTurn,
		estimateCtx: () => estimateCtxRatio(session),
		contextWindow: () => contextWindowTokens(),
	};
	// the ergonomics batch C8: the auto-compact check — the /compact FULL path via the
	// shared dispatch (same notices, same chain ordering, same mid-run
	// refusal — the isRunning guard here only avoids the refusal's noise).
	// The appended segment is NOT awaited here on purpose: from inside a
	// chain segment, awaiting the append would be circular (the segment
	// chains after THIS segment's promise). The exit path re-awaits the
	// chain once more after the turn — see the final awaits in chat().
	const maybeAutoCompact = (): void => {
		if (autoCompact === undefined) return;
		if (currentRun !== null) return; // dispatch would refuse — skip the noise
		const ratio = estimateCtxRatio(session);
		if (!Number.isFinite(ratio) || ratio < autoCompact.thresholdRatio) return;
		dispatch("/compact", dispatchCtx);
	};
	input.onLine((line) => {
		if (!replReady) {
			queuedLines.push(line);
			return;
		}
		dispatch(line, dispatchCtx);
	});
	// W15: the expand key — the editor forwards ctrl+r; dispatch runs the
	// chain action (the sentinel's control char marks the key, so a typed
	// "expand" turn is never intercepted).
	input.onExpand(() => dispatch("\x12expand", dispatchCtx));

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	// round 8: the startup resume is bound to currentRun — Ctrl+C during it
	// aborts the recovery, exactly like the interactive turns.
	await resolveUncertains(session, input, () => cancelled);
	if (!cancelled) {
		const recoveryRun = session.resume();
		currentRun = recoveryRun;
		turnNo += 1;
		const last = await consumeRun(session, recoveryRun, input, turnNo, faux, statusCb, submitTurn);
		currentRun = null;
		failOnFauxExhaustion(last, faux, input);
		// E group (the graceful-exit gate ③): the same deferred re-check
		// as the turn path — the recovery run's end is also a safe point.
		if (eotSeen) exitAtEmptyPrompt();
		maybeAutoCompact(); // the ergonomics batch C8: the recovery run ended too — same check (awaited by the exit re-await)
	}
	if (cancelled) {
		input.close();
		await input.closed;
		return;
	}
	// The REPL is ready: replay anything that arrived during recovery.
	replReady = true;
	// v2c: dispatch SYNCHRONOUSLY — each call appends its segment to the
	// chain variable; the final `await chain` then covers every replayed
	// turn. A chain.then(() => dispatch()) indirection would capture the
	// chain BEFORE the appends and the replayed turns would never be
	// awaited (the F-group regression).
	for (const line of queuedLines) {
		dispatch(line, dispatchCtx);
	}
	queuedLines.length = 0;
	input.prompt();
	await input.closed;
	await chainRef.current; // never exit while a turn is in flight
	// the ergonomics batch C8: the auto-compact may have appended ITS segment inside the
	// turn (the check runs at the turn's end, after the exit-await above
	// already captured the chain) — re-await once so the summarize either
	// runs before the exit or the chain is already settled. One level is
	// enough: the /compact segment appends nothing of its own.
	await chainRef.current;
}
