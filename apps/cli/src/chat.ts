/**
 * 手感批 B4 (pure move) — the interactive REPL (chat), the run consumer
 * (consumeRun — the single renderer of a run's event stream), the
 * approval-moment mini-diff, the status spinner, and the context
 * estimates. All bodies moved verbatim from index.ts.
 */

import { readFileSync } from "node:fs";
import { escapeTerminal, kUnit, palette, renderEvent, renderRecap, type RenderInput, type RunUsage } from "@vincemakes/kiso-tui";
import { editFileDiff, writeFileDiff, type DiffResult } from "@vincemakes/kiso-tui";
import { canonicalTargetPath } from "@vincemakes/kiso-tools-node";
import type { AgentSession } from "@vincemakes/kiso-runtime";
import { dispatch, type DispatchCtx } from "./dispatch.js";
import { CANCELLED, agentModel, body, bodyLog, dock, type LineInput } from "./state.js";
import { ask, pendingAsk, resolveUncertains } from "./trust-ui.js";
import { FauxExhaustionError, failOnFauxExhaustion } from "./faux-glue.js";
import { MODES, getMode, setMode } from "./mode.js";

/** B 区: default context window for the ~ctx estimate (config overridable). */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * C 区: the model window in tokens — KISO_CONTEXT_WINDOW overrides the
 * 200k default. The microcompact threshold is derived from it (50%), and
 * the status line's ~ctx estimate is measured against it — one source of
 * truth for the window.
 */
export function contextWindowTokens(): number {
	const window = Number.parseInt(process.env.KISO_CONTEXT_WINDOW ?? "", 10);
	return Number.isFinite(window) && window > 0 ? window : DEFAULT_CONTEXT_WINDOW;
}

/**
 * B 区: approximate context ratio — chars/4 of the projected messages vs
 * the model window. Marked ~ everywhere it is shown; no counting API.
 */
export function estimateCtxRatio(session: AgentSession): number {
	const projected = session.projected();
	const chars = JSON.stringify(projected).length;
	return chars / 4 / contextWindowTokens();
}

/** v2b: the spinner merged into the STATUS BAR (the v2a standalone glyph
 *  is gone) — docked only, 200ms rotation between the request and the
 *  first event. */
export function startStatusSpinner(onTick: (glyph: string) => void): () => void {
	if (!dock.active) return () => {};
	// v3 §03/§05: the working glyph family ▖▘▝▗, 200ms rotation — the
	// callback repaints the running status line with the new glyph.
	const GLYPHS = ["▖", "▘", "▝", "▗"];
	let i = 0;
	const timer = setInterval(() => onTick(GLYPHS[i++ % GLYPHS.length]!), 200);
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
			return editFileDiff(oldContent ?? "", search, replace);
		}
		const content = typeof input.content === "string" ? input.content : "";
		return writeFileDiff(oldContent, content);
	} catch {
		return null; // never let the diff break the approval
	}
}

/**
 * 手感批 C5 — the translation layer: the tui renders its OWN data shape
 * (RenderInput, zero kiso-core imports); the CLI translates its Event
 * stream here. Events without a render (stop, expired, resolved, …) → null,
 * and the consumer skips them — the pipe bytes stay identical.
 */
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
 * marks a session.resume() continuation. v2a: `faux` picks the status
 * line's form; `liveInput` (non-null only in interactive chat) carries the
 * last line THIS process's readline consumed — the double-echo filter.
 */
export async function consumeRun(
	session: AgentSession,
	run: AsyncIterable<import("@vincemakes/kiso-core").Event>,
	input: LineInput,
	turnNo: number,
	faux: boolean,
	liveInput: { current: string | null } | null,
	statusCb: ((usage: RunUsage, ctxRatio: number) => void) | null,
): Promise<import("@vincemakes/kiso-core").Event | undefined> {
	let last: import("@vincemakes/kiso-core").Event | undefined;
	let usage: RunUsage = { in: null, out: null, cache: null, known: false };
	// v3 §02: the recap line derives ENTIRELY from the local event stream
	// (zero tokens) — wall seconds, tool/edit counts, usage, ctx left.
	const turnStart = Date.now();
	let toolCount = 0;
	let editCount = 0;
	try {
	for await (const ev of run) {
		last = ev;
		// v2a (双回显): the interactive echo was already rendered by the
		// input source — rendering the event again is the double echo.
		// v2b: DOCKED — the echo lives in the input row (H), NOT the body;
		// the body render is the ONLY visible copy of the sent line.
		if (
			ev.type === "user_input" &&
			liveInput !== null &&
			liveInput.current === (typeof ev.content === "string" ? ev.content : "") &&
			process.stdin.isTTY &&
			!dock.active
		) {
			continue;
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
				break;
			case "tool_execution_started":
				body.toolRunning(ev.callId);
				break;
			case "tool_execution_succeeded":
				body.toolSucceeded(ev.callId);
				break;
			case "tool_execution_failed":
				body.toolFailed(ev.callId, ev.error);
				break;
			case "tool_result": {
				const text = typeof ev.content === "string" ? ev.content : "";
				body.toolResult(ev.callId, { content: text, isError: ev.isError });
				break;
			}
			case "text_delta":
				body.textAppend(ev.text);
				break;
			case "text_end":
				body.textEnd();
				break;
			case "usage":
				usage = { in: ev.inputTokens, out: ev.outputTokens, cache: ev.cacheRead, known: ev.known };
				statusCb?.(usage, estimateCtxRatio(session));
				break;
			case "uncertain_pending":
				// 裁决 #12 (ADR-0038): the ⚠ line is pure INFORMATION now — the
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
				const name = (ev as { name: string }).name;
				body.toolApproval(ev.callId, approvalDiff(name, ev.input ?? {}));
				const decisionId = (ev as { decisionId: string }).decisionId;
				const answer = await ask(input, `approve ${escapeTerminal(name)}? (y/n) `);
				if (answer === CANCELLED) {
					// 十: a cancellation is a CONSERVATIVE denial, explicitly
					// distinguished from the user typing "n".
					body.notice("[approval cancelled — treated as a denial]");
					await session.approve(decisionId, false);
					continue;
				}
				await session.approve(decisionId, answer.trim().toLowerCase().startsWith("y"));
				break;
			}
			case "terminal": {
				// v3 §02: the run's recap line REPLACES the old "done" label
				// + status line — one local line, derived from this run's
				// events (zero tokens). The dock's status bar still paints.
				statusCb?.(usage, estimateCtxRatio(session));
				const ratio = estimateCtxRatio(session);
				bodyLog(
					renderRecap({
						seconds: Math.round((Date.now() - turnStart) / 1000),
						tools: toolCount,
						edits: editCount,
						usage,
						ctxLeftPct: Number.isFinite(ratio) ? (1 - ratio) * 100 : null,
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
	}
	return last;
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
export async function chat(session: AgentSession, faux: boolean, input: LineInput): Promise<void> {
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;

	const turn = (text: string): Promise<void> =>
		new Promise((resolve, reject) => {
			queued = Math.max(0, queued - 1); // a queued turn starts
			// v2a: the echo filter compares the user_input event against THIS
			// turn's own input — lines that arrive ahead of their turn (piped
			// bursts, queued replays) must not overwrite the reference.
			liveInput.current = text;
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
					last = await consumeRun(session, run, input, myTurn, faux, liveInput, statusCb);
					stopSpinner();
					paintIdle();
					currentRun = null;
					// 八: a faux script that ran out of declared turns exits
					// loudly with a non-zero status — never a silent status 0.
					// 第四轮(对抗): the exhaustion is a CONTROLLED rejection of
					// this turn's promise — it propagates through the chain to
					// chat to main's finally/catch, never an orphaned
					// unhandled rejection from the IIFE.
					failOnFauxExhaustion(last, faux, input);
					// 八: after EVERY turn the prompt is re-armed — the human
					// never types blind after the first turn.
					input.prompt();
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
			// 八: Ctrl+C cancels BOTH the pending question (if one is
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
		if (!currentRun && pendingAsk === null && input.line() === "") {
			cancelled = true;
			console.log("\n[exit requested]");
			input.close();
		}
	});
	input.onEscape(() => {
		if (currentRun) {
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		}
	});

	// 第五轮(P1-11): the PERSISTENT line listener is installed BEFORE the
	// startup recovery — a cancelled question's re-emitted "line" needs a
	// listener from the very first instant, or the input is silently lost.
	// Turns are SERIALIZED on a chain — piped lines arrive faster than
	// turns complete, and concurrent runs are forbidden. Lines that arrive
	// while the recovery is still running are QUEUED and replayed once the
	// REPL is ready (they are never dropped).
	const chainRef: { current: Promise<void> } = { current: Promise.resolve() };
	let replReady = false;
	const queuedLines: string[] = [];
	// B 区: user-turn counter for the status line. /last and /think read
	// the body (the ToolCell / ThinkingCell final states).
	let turnNo = 0;
	// v2a: the last line THIS process's readline consumed — the double-echo
	// filter (see consumeRun). Only interactive chat sets it.
	const liveInput: { current: string | null } = { current: null };
	// v2c: turns submitted while another runs are QUEUED on the chain — the
	// live count rides the status bar (+N queued).
	let queued = 0;
	// v2b: the live status bar (docked only). Modes: /mode switches repaint
	// it immediately through paintStatus (the last turn stats are kept).
	// v3 §03: the status bar has TWO states. Idle: the mode is ALWAYS
	// shown (default included) with the /mode hint. Running: the working
	// glyph (▖▘▝▗ — the spinner drives it) + wall seconds + ↓ out tokens
	// + the interrupt hint. ctx left is the live estimate everywhere.
	let runUsage: RunUsage = { in: null, out: null, cache: null, known: false };
	let runGlyph = "▖";
	let runStart = Date.now();
	const paintRunning = (): void => {
		if (!dock.active) return;
		const ratio = estimateCtxRatio(session);
		const pct = Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
		const out = runUsage.out !== null ? ` ↓ ${kUnit(runUsage.out)} tokens` : "";
		dock.setStatus(
			`${runGlyph} working ${Math.max(1, Math.round((Date.now() - runStart) / 1000))}s${out} · esc to interrupt · ctx left ~${pct}%`,
		);
	};
	const paintIdle = (): void => {
		if (!dock.active) return;
		const ratio = estimateCtxRatio(session);
		const pct = Number.isFinite(ratio) ? Math.round((1 - ratio) * 100) : null;
		dock.setStatus(`▸ ${getMode()} · /mode to switch · ${agentModel} · ctx left ~${pct}%`);
	};
	const statusCb = (u: RunUsage, ctx: number): void => {
		runUsage = u;
		paintRunning();
	};
	const submitTurn = (line: string): void => {
		queued += 1;
		chainRef.current = chainRef.current.then(() => turn(line));
	};
	const dispatchCtx: DispatchCtx = {
		session,
		input,
		chainRef,
		isRunning: () => currentRun !== null,
		paintIdle,
		submitTurn,
		estimateCtx: () => estimateCtxRatio(session),
	};
	input.onLine((line) => {
		if (!replReady) {
			queuedLines.push(line);
			return;
		}
		dispatch(line, dispatchCtx);
	});

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	// 八: the startup resume is bound to currentRun — Ctrl+C during it
	// aborts the recovery, exactly like the interactive turns.
	await resolveUncertains(session, input, () => cancelled);
	if (!cancelled) {
		const recoveryRun = session.resume();
		currentRun = recoveryRun;
		turnNo += 1;
		const last = await consumeRun(session, recoveryRun, input, turnNo, faux, liveInput, statusCb);
		currentRun = null;
		failOnFauxExhaustion(last, faux, input);
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
}
