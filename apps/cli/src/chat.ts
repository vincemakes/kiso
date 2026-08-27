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
	verifyOfferView,
	STATUS_GLYPHS,
	type PanelArgs,
	type PanelView,
	type RenderInput,
	type RunUsage,
} from "@vincemakes/kiso-tui";
import { deletionRiskHint, editFileDiff, writeFileDiff, type DiffResult, type SaferAnswer, type SaferFailure, type SaferOption } from "@vincemakes/kiso-tui";
import { canonicalTargetPath, shellProgressPath } from "@vincemakes/kiso-tools-node";
import { canonicalizeUsage } from "@vincemakes/kiso-runtime";
import { canonicalizeUsageForModel } from "@vincemakes/kiso-runtime/internal";
import type { AgentSession, Run } from "@vincemakes/kiso-runtime";
import { dispatch, type DispatchCtx } from "./dispatch.js";
import { agentModel, body, bodyLog, configuredWindow, dock, type LineInput } from "./state.js";
import { attachImages } from "./attachments.js";
import { lookupModelMetadata } from "@vincemakes/kiso-runtime/internal";
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
	if (Number.isFinite(window) && window > 0) return window;
	// PH-1c (finding PH-F15): the window follows the LIVE model when the
	// metadata registry knows it — /model to a known model moves the
	// window (and the microcompact threshold derived from it) without an
	// env var. agentModel is the same live binding the status row shows;
	// an unknown model keeps the 200k default — the registry never
	// guesses, so neither do we.
	const known = lookupModelMetadata(agentModel)?.capabilities.contextWindow;
	if (known !== undefined && known !== null) return known;
	return DEFAULT_CONTEXT_WINDOW;
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
	// PH-1c: the LIVE model — when given, the $cost keys on the model's
	// metadata entry (an unpriced model shows null, never a route-table
	// guess); omitted, the legacy route-keyed path stands (old callers,
	// old tests, unchanged bytes).
	model?: string,
): UsageDelta {
	const c = model === undefined ? canonicalizeUsage(route ?? "adapter", ev) : canonicalizeUsageForModel(model, undefined, route ?? "adapter", ev);
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

/**
 * TUI2-R3v2 ③ — the safer-options request: its prompt, and its parser.
 *
 * The prompt is deliberately small. It carries the pending call and
 * nothing else — no conversation, no tools, no project context — because
 * everything it does not send is rent the human pays for pressing a
 * button, and because "propose a safer version of THIS command" is a
 * question that needs no history to answer.
 */
/** TUI2-R3v2 ③: tools whose NEXT approval is the model's answer to a
 *  refusal — the "(amended)" marker's source. Per process, cleared as
 *  soon as it is shown: the marker describes ONE call, not a mode. */
const amendedCalls = new Set<string>();

/**
 * R3v2-F1: the format contract, stated FIRMLY. The first cut asked for
 * "JSON ONLY" and left it there, which a verbose model reads as a
 * preference — it wrote three sentences of preamble, opened a fence, and
 * the cap ended the reply mid-string. Forbidding prose, naming the exact
 * schema, and giving the nothing-is-safer case its own literal answer
 * are all the same instruction: there is one thing to emit and no room
 * to be helpful in the margins.
 *
 * The schema is an ENVELOPE rather than a bare array because a single
 * top-level object leaves the model nowhere to put a preamble.
 */
export const SAFER_SYSTEM_PROMPT = [
	"You propose safer alternatives to a single shell/tool call a human is being asked to approve.",
	"Reply with JSON ONLY — no prose, no preamble, no code fence, nothing before or after the JSON.",
	'The exact schema is {"alternatives":[{"command":"...","reason":"..."}]}, with 2-3 entries.',
	'"command" is the full replacement call. "reason" is ONE line of plain language saying what it does differently.',
	'Prefer alternatives that avoid irreversible deletion. If you cannot improve on it, reply {"alternatives":[]}.',
].join(" ");

/**
 * R3v2-F1: the side query's output ceiling — raised from 500, which was
 * the cap the live failures hit EXACTLY.
 *
 * The JSON-only reply the prompt now asks for is about 200 tokens for
 * three alternatives, so this ceiling is a runaway guard and not a
 * budget the answer is expected to approach: it exists so a model that
 * ignores the contract and writes an essay still stops, not so the
 * answer has room. Output is billed only when generated, and the query
 * fires only on a press, so the raise costs nothing on the path that
 * works and removes the one that could not.
 */
export const SAFER_MAX_TOKENS = 1500;

/**
 * R3v2-F1: WHY the ask failed, when the reply's own text can prove it.
 *
 * This side reports the cause and never the copy — the sentences live in
 * the panel package, next to each other, so there is one place where the
 * words are chosen and one place they can drift from.
 *
 * "Cut short" is a DIAGNOSIS, so it is only claimed when the text shows
 * it: a reply that closed its JSON and then failed our SHAPE returns
 * null and gets the unqualified line, because telling that human their
 * reply was truncated would be a confident wrong answer.
 */
export function saferFailure(text: string): SaferFailure | null {
	return jsonBody(text) === "truncated" ? { reason: "truncated" } : null;
}

/**
 * R3v2-F1: find the reply's JSON body by BALANCING brackets rather than
 * by first-and-last.
 *
 * `indexOf("[")` / `lastIndexOf("]")` had two failure modes a verbose
 * model hits constantly: a bracket in the trailing prose moved the end
 * past the array, and a reply the cap cut in half had no end at all.
 * Both returned null, and null could not say which — which is why the
 * degradation line could not either.
 *
 * Returns the balanced slice, `"truncated"` when a value opens and the
 * text ends before it closes, or null when there is no JSON value at
 * all.
 */
function jsonBody(text: string): string | "truncated" | null {
	// a CLOSED fence is content-preserving to strip. An OPEN one means
	// the reply ended inside the block — drop the opener and let the scan
	// below reach the same verdict from the content.
	const closed = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	const body = closed?.[1] ?? text.replace(/^[\s\S]*?```(?:json)?[ \t]*\r?\n/, "");
	const start = body.search(/[[{]/);
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < body.length; i += 1) {
		const c = body[i]!;
		if (escaped) {
			escaped = false;
		} else if (inString) {
			if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
		} else if (c === '"') {
			inString = true;
		} else if (c === "[" || c === "{") {
			depth += 1;
		} else if (c === "]" || c === "}") {
			depth -= 1;
			if (depth === 0) return body.slice(start, i + 1);
			if (depth < 0) return null;
		}
	}
	return "truncated";
}

/**
 * Parse the model's answer DEFENSIVELY — anything unexpected is a
 * failure, and a failure degrades honestly.
 *
 * The temptation here is to be clever: salvage a half-parse, coerce a
 * string into a command, accept an object where an array was asked for.
 * All of that produces a list of alternatives the model did not propose,
 * shown to a human deciding whether to run a destructive command. The
 * only honest failure mode is the dim line, so anything that is not
 * exactly the requested shape returns null.
 *
 * A fenced code block is the one accommodation, because models emit it
 * constantly and it changes no content.
 *
 * R3v2-F1 widens that accommodation and NOTHING else. Unwrapping the
 * named `alternatives` envelope, and reading `reason` as the spelling of
 * `why` the prompt now asks for, are transport details: the entries that
 * come out are verbatim the entries the model put in. That is the line
 * between an accommodation and the salvage this parser refuses — a
 * salvage changes WHICH alternatives are shown, and every rule that does
 * that is still here. One bad entry still poisons the batch.
 */
export function parseSaferOptions(text: string): SaferOption[] | null {
	const body = jsonBody(text);
	// truncation and absence part ways in saferFailureNote(), which reads
	// the same scan; for the list itself both are the same nothing.
	if (body === null || body === "truncated") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return null;
	}
	const envelope = typeof parsed === "object" && parsed !== null ? (parsed as { alternatives?: unknown }).alternatives : undefined;
	const list = Array.isArray(parsed) ? parsed : Array.isArray(envelope) ? envelope : null;
	if (list === null || list.length === 0) return null;
	const out: SaferOption[] = [];
	for (const item of list.slice(0, 3)) {
		if (typeof item !== "object" || item === null) return null;
		const { command, reason, why } = item as { command?: unknown; reason?: unknown; why?: unknown };
		if (typeof command !== "string" || command.trim() === "") return null;
		const line = typeof reason === "string" ? reason : typeof why === "string" ? why : "";
		out.push({ command: command.trim(), why: line.trim() });
	}
	return out.length === 0 ? null : out;
}

/** TV-1B — the plain-word verdict tail for the settled checklist.
 *  "no passing check yet" covers both never-ran and ran-and-failed
 *  without lying; "outdated" claims only what the trajectory proves. */
function taskVerdictWords(kind: "verified" | "stale" | "none" | "unreadable"): string {
	switch (kind) {
		case "verified":
			return "checked \u2713";
		case "stale":
			return "check outdated \u2014 work may have changed after it";
		case "none":
			return "no passing check yet";
		case "unreadable":
			return "task list unreadable";
	}
}

/** W21 — the panel view for a permission_requested: the rule line (the
 *  why-asked speaker + the §3.5 fix hint), the toolTarget title, the
 *  "⏸ run paused" status, and the ALWAYS-verbose args. */
function approvalView(name: string, ev: { speaker?: string; input?: Record<string, unknown> }, amended = false): PanelView {
	const speaker = ev.speaker ?? "kiso";
	const input = ev.input ?? {};
	// exactOptionalPropertyTypes: the hint is OMITTED when the speaker has
	// no fix (mode:accept-edits, shell in default) — never `hint: undefined`.
	const hint = fixHintFor(speaker, name);
	// TUI2-R3v2 ④: the deletion-risk line, for shell calls whose command
	// matches one of the four irreversible patterns. Local rules, no
	// request, and absent for every other command — which is most of them.
	const risk = name === "shell" ? deletionRiskHint(String(input.command ?? "")) : null;
	return {
		flavor: "approval",
		name,
		title: toolTarget(name, input),
		speaker,
		...(hint !== undefined ? { hint } : {}),
		...(risk !== null ? { riskHint: risk } : {}),
		statusText: "⏸ run paused",
		args: approvalArgs(name, input),
		fallbackQuestion: `approve ${escapeTerminal(name)}? (y/n) `,
		// TUI2-R3v2 ③: the v4 frame's "(amended)" marker. It says WHY this
		// call looks different from the one just refused — without it, a
		// second approval for the same tool reads as the product asking
		// twice rather than as the model answering.
		...(amended ? { amended: true } : {}),
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
				// TV-1B: a system-sourced input is PRODUCT MACHINERY — visible
				// (every durable input renders) but never painted as the
				// user's words. Provenance is honest on screen, not only in
				// the log.
				if (ev.source === "system") {
					// R2 (law 1.3): the ◆ said nothing the words did not. What
					// makes this row honest is that it NAMES itself machinery.
					body.notice("verification pass");
					body.notice(`  ${typeof ev.content === "string" ? ev.content : ""}`);
					break;
				}
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
			case "model_output_abandoned":
				// F4: the transcript must not glue drafts — the durable void
				// closes the abandoned draft VISIBLY, and the retried stream
				// (or the error terminal) opens on a fresh block. Without
				// this, the projection is clean while the screen welds two
				// answers into one — the surface-lying class.
				body.textEnd();
				body.notice("stream interrupted — the draft above is abandoned");
				break;
			case "usage": {
				const delta = usageFromEvent(session.provider, ev, prevTotal, agentModel);
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
				// TUI2-R3v2 ③: the on-demand alternatives provider. It is built
				// per approval and captured by the panel; it fires ONLY if the
				// human presses option 3, which is the whole zero-ambient-rent
				// mechanism — no press, no request, nothing in the trace.
				const safer = async (): Promise<SaferAnswer> => {
					const answer = await session.sideQuery({
						purpose: "safer-options",
						systemPrompt: SAFER_SYSTEM_PROMPT,
						prompt: `the pending call is: ${name} ${JSON.stringify(ev.input ?? {})}`,
						maxTokens: SAFER_MAX_TOKENS,
					});
					// R3v2-F1: a failure reports its CAUSE when the reply can
					// prove one, so the panel can say which failure this was.
					// saferFailure() returns null for every cause we cannot
					// demonstrate, which is the unqualified line — unchanged.
					return parseSaferOptions(answer) ?? saferFailure(answer);
				};
				const verdict = await askPanel(
					input,
					approvalView(name, ev as { speaker?: string; input?: Record<string, unknown> }, amendedCalls.has(name)),
					{ safer },
				);
				amendedCalls.delete(name);
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
							// TUI2-R3v2 ③: whatever the model proposes next for
							// this tool IS the amended call, and the panel says so.
							amendedCalls.add(name);
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
				// TV-1B: the settle verdict — the checklist stops lying. When
				// every item is CLAIMED done, the settled block's tail says
				// what the projection actually proves ("no passing check yet"
				// covers never-ran AND ran-and-failed; "may have changed"
				// claims trajectory knowledge, never filesystem knowledge).
				// A run that emitted no task_set still gets the block: the
				// claims live in the durable log, and the settle SYNTHESIZES
				// the display from session.assessTasks() — a UI projection,
				// never a new durable fact.
				const tv = session.assessTasks();
				if (tv.claims.length > 0 && tv.allClaimedDone) {
					body.checklist(taskVerdictWords(tv.evidence.kind), tv.claims.map((c) => ({ text: c.text, status: c.status })));
				}
				// W14: the turn record closes HERE — before the recap logs, so
				// the commit loop folds the quiet turn's held cells first (the
				// fold line lands above the recap, natural cell order).
				body.endTurn(Math.round(thoughtSeconds));
				// D4: the max_tokens truncation is named, never silent — the
				// honest notice rides after the partial answer, before the
				// recap (the truncation-guard philosophy: the cut is visible
				// in the scrollback, the model's own text intact).
				if (ev.outcome.kind === "max_tokens") {
					// R2 (law 1.1): the notice was wearing a box corner. A notice
					// is a sentence addressed to a human; it needs no edge.
					body.notice('answer truncated at max_tokens — say "continue" to finish');
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
/** The chat loop's ENDING: exit closes the process's REPL for good; a
 *  switch hands main another session id to re-enter chat with — the
 *  editor survives, the durable law is untouched (the /resume+/clear
 *  mini-spec). */
export type ChatEnd = { readonly next: "exit" } | { readonly next: "switch"; readonly id: string };

/** The session-navigation seam main provides: the OTHER sessions'
 *  ids, and (when a dock is up) the existing picker. */
export interface ChatNav {
	readonly sessions: () => readonly string[];
	readonly pick?: () => Promise<string | null>;
}

export async function chat(session: AgentSession, faux: boolean, input: LineInput, autoCompact?: AutoCompact, nav?: ChatNav): Promise<ChatEnd> {
	// the switch directive — set once by dispatch's /clear or /resume,
	// resolved through the end signal so the final awaits still run
	let switchTo: string | null = null;
	let resolveEnd: () => void = () => {};
	const endSignal = new Promise<void>((r) => {
		resolveEnd = r;
	});
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

	const turn = (text: string, seedSource?: "system"): Promise<void> =>
		new Promise((resolve, reject) => {
			queued = Math.max(0, queued - 1); // a queued turn starts
			// REL-0152-D11: a turn that names an image file carries it. The
			// scan returns the STRING unchanged when it finds nothing, so a
			// turn without one is byte-identical to before the feature.
			// Seeded turns are the product's own words and are never
			// scanned — nothing it writes to itself is an attachment.
			// REL-0152-D16: the capsules' files come from the editor, which
			// is the only thing that knows which number stands for which
			// screenshot.
			const content = seedSource !== undefined ? text : attachImages(text, input.attachments?.());
			const run = seedSource !== undefined ? session.run(content, { source: seedSource }) : session.run(content);
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
					// TV-1B — the thin task driver. A VERIFICATION turn settling
					// consumes the task-set identity it produced (a verifier's
					// own task_set belongs to the SAME accepted offer) and never
					// opens another offer. A normal COMPLETED settle may offer —
					// gated so the suggestion always yields to human intent.
					if (seedSource === "system") {
						const after = session.assessTasks();
						if (after.lastTaskSetSeq !== null) offeredTaskSeqs.add(after.lastTaskSetSeq);
					} else if (
						last?.type === "terminal" &&
						last.outcome.kind === "completed" &&
						process.stdin.isTTY &&
						!cancelled &&
						!eotSeen &&
						pendingAsk === null &&
						pendingTurns.length === 0 &&
						input.line() === ""
					) {
						const tv = session.assessTasks();
						if (
							tv.claims.length > 0 &&
							tv.allClaimedDone &&
							(tv.evidence.kind === "none" || tv.evidence.kind === "stale") &&
							tv.lastTaskSetSeq !== null &&
							!offeredTaskSeqs.has(tv.lastTaskSetSeq)
						) {
							const verdict = await askPanel(input, verifyOfferView());
							// an explicit answer — Yes, Not now, OR Esc — consumes
							// the offer for THIS claims-set; only gate-suppression
							// (above) leaves it live for a later settle.
							offeredTaskSeqs.add(tv.lastTaskSetSeq);
							if (verdict.action === "allow") {
								queued += 1; // turn() decrements — keep the ledger honest
								chainRef.current = chainRef.current.then(() => turn(VERIFY_SEED, "system"));
							}
						}
					}
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
	// TV-1B — the offer memory: session-local BY DESIGN (a dead process's
	// "not now" should not silence a live one; resume re-offers once,
	// honestly), keyed by the assessed claims' identity.
	const offeredTaskSeqs = new Set<number>();
	// The fixed verification seed — durable with source:"system": WHO asked
	// is provenance in the log; on the provider wire it stays an ordinary
	// user-role message (never a system-prompt escalation).
	const VERIFY_SEED = "Verify the completed work: run the project's checks and report what passes and what fails.";
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
	// TUI2-R2 ⑥ — the BOOT status line. The row is the product's one
	// persistent claim about itself (the tier, how to change it, the model,
	// the context left), and it used to appear after turn ONE: the
	// idle-fresh screen — the screen every session opens on — showed an
	// empty row where all of that belongs.
	//
	// Nothing had to be computed to fix it. paintIdle already had every
	// field at this point: the mode is set before the agent is built, the
	// model is resolved inside it, and an unstarted session's context
	// estimate is a perfectly good 100%. It was simply never called until
	// a turn ended. One call, and the SAME formatter — a boot-time copy of
	// the row would drift from the real one the moment either changed.
	paintIdle();
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
		// the /resume+/clear mini-spec: the switch directive and the
		// session-navigation seam (absent nav = the commands degrade to
		// an honest refusal in dispatch)
		requestSwitch: (id: string) => {
			switchTo = id;
			resolveEnd();
		},
		sessions: () => nav?.sessions() ?? [],
		...(nav?.pick !== undefined ? { pickSession: nav.pick } : {}),
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
	// R3a — Shift+Tab: the approval-tier cycle (the /mode ring, in the
	// MODES order). The switch is the SAME live-extension flip /mode
	// performs; the status row repaints at once with a one-line notice.
	input.onModeCycle?.(() => {
		const next = MODES[(MODES.indexOf(getMode()) + 1) % MODES.length]!;
		setMode(next);
		paintIdle();
		body.notice(`mode → ${next} (shift+tab cycles)`);
	});

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
		// TUI2-R1.5 ③ (VD-3 family): stamp the run's start AT the run's
		// entry. Every other run path does; this one inherited the value
		// from the process's own startup, so its "working Ns" was the
		// session's age rather than the recovery's. The drift is small
		// today (recovery follows startup closely) and unbounded in
		// principle — a slow MCP connect is seconds the recovery never
		// spent, reported as seconds it did.
		runStart = Date.now();
		runUsage = { in: null, out: null, cache: null, known: false };
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
		return { next: "exit" };
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
	// the REPL ends by CLOSE (exit) or by SWITCH (/clear, /resume) — the
	// switch leaves the editor alive for the next chat() entry
	await Promise.race([input.closed, endSignal]);
	await chainRef.current; // never exit while a turn is in flight
	// the ergonomics batch C8: the auto-compact may have appended ITS segment inside the
	// turn (the check runs at the turn's end, after the exit-await above
	// already captured the chain) — re-await once so the summarize either
	// runs before the exit or the chain is already settled. One level is
	// enough: the /compact segment appends nothing of its own.
	await chainRef.current;
	return switchTo === null ? { next: "exit" } : { next: "switch", id: switchTo };
}
