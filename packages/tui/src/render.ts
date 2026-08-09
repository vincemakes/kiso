/**
 * Event rendering for the terminal. Pure (testable): given the render
 * input, produce the lines a human sees. Colors are raw ANSI — no
 * dependencies.
 *
 * the ergonomics batch C5: the input is the tui's OWN data shape (RenderInput), never
 * kiso-core's Event — the CLI translates Event → RenderInput. The tui
 * package has ZERO kiso-core imports: input is data, output is bytes.
 *
 * ADR-0043 Amendment 4: the cell-rendering slice (the twelve helpers
 * components.ts imports) moved to tui-cells — this module re-exports
 * it (compositor.ts and index.ts's imports stay verbatim) and keeps
 * the event renderers (renderEvent, the status line, the recap, the
 * session line).
 */

import { escapeTerminal, foldResult, foldThinking, kUnit, palette } from "@vincemakes/kiso-tui-cells/render";
export * from "@vincemakes/kiso-tui-cells/render";

/** The canonical-path resolver for the approval detail — injected by the
 *  caller (the CLI passes the tools' own resolution). The tui package is
 *  pure terminal: input is data, output is bytes, zero runtime deps. */
export type PathResolver = (path: string) => string;

export interface RenderResult {
	readonly text: string;
	readonly newline: boolean;
	readonly prompt: boolean;
}

/**
 * the ergonomics batch C5 — the render input, the tui's OWN data shape: the subset of
 * an event stream the renderer reads, keyed by type. The CLI translates
 * its Event stream into this (Event → RenderInput) before rendering —
 * the tui package never imports kiso-core. Field names mirror the
 * rendered Event members so the render body stays byte-identical.
 */
export type RenderInput =
	| { readonly type: "user_input"; readonly content: string | readonly { readonly type?: string; readonly text?: string }[] }
	| { readonly type: "text_delta"; readonly text: string }
	| { readonly type: "text_end" }
	| { readonly type: "thinking"; readonly text: string }
	| { readonly type: "tool_call_end"; readonly name: string; readonly input: Readonly<Record<string, unknown>> | null }
	| { readonly type: "tool_execution_started" }
	| { readonly type: "tool_execution_succeeded" }
	| { readonly type: "tool_execution_failed"; readonly error: string }
	| { readonly type: "tool_result"; readonly content: string | readonly { readonly type?: string; readonly text?: string }[]; readonly isError: boolean }
	| { readonly type: "permission_requested"; readonly name: string; readonly input: Readonly<Record<string, unknown>> }
	| { readonly type: "permission_decided"; readonly decision: "approved" | "denied"; readonly reason?: string }
	| {
			readonly type: "terminal";
			readonly outcome:
				| { readonly kind: "completed" }
				| { readonly kind: "max_tokens" }
				| { readonly kind: "max_turns"; readonly turns: number }
				| { readonly kind: "error"; readonly error: { readonly message: string } }
				| { readonly kind: "aborted"; readonly by: string }
				| { readonly kind: "hook_stopped"; readonly hook: string };
		}
	| { readonly type: "compacted"; readonly cleared: readonly { readonly eventSeq?: number; readonly callId: string }[] }
	| { readonly type: "summarized"; readonly coversToSeq: number }
	| { readonly type: "uncertain_pending"; readonly name: string; readonly executionId: string; readonly error: string }
	| {
			// ⑥ task round: the durable checklist — the CLI translates a
			// do-not-compact-tagged tool result into this shape; the tui
			// renders the brick glyphs (□ pending / ▖ active / ▣ done).
			readonly type: "checklist";
			readonly header: string;
			readonly items: readonly { readonly text: string; readonly status: "pending" | "active" | "done" }[];
	  };

/**
 * Render one event. `text` may be a continuation (text_delta appends to the
 * current line); `newline` says whether the line is complete.
 *
 * bootstrap P1: `prevThinking` marks a thinking delta that continues the SAME
 * block — it renders appended to the segment, without the … prefix. The
 * consumer closes the segment with a newline at the next non-thinking
 * event.
 */

export function renderEvent(ev: RenderInput, prevThinking = false, resolvePath: PathResolver = (p) => p): RenderResult {
	const p = palette();
	switch (ev.type) {
		case "user_input":
			// v2a/v5: bold (the identity accent — the interactive prompt
			// echoes itself; this render is the REPLAY path).
			return { text: `${p.bold}you> ${escapeTerminal(typeof ev.content === "string" ? ev.content : "(content)")}${p.reset}\n`, newline: true, prompt: false };
		case "text_delta":
			return { text: escapeTerminal(ev.text), newline: false, prompt: false };
		case "text_end":
			return { text: "\n", newline: true, prompt: false };
		case "thinking":
			// bootstrap P1/v2b: the CONSUMER buffers each thinking block and folds
			// it to ONE dim line (foldThinking); this render is the generic
			// path for tests. The full block goes to /think.
			return {
				text: foldThinking(ev.text),
				newline: true,
				prompt: false,
			};
		case "tool_call_end":
			// v2a: plain — the call line is information, not decoration.
			return {
				text: `→ ${escapeTerminal(ev.name)}(${ev.input ? escapeTerminal(JSON.stringify(ev.input).slice(0, 200)) : ""})\n`,
				newline: true,
				prompt: false,
			};
		case "tool_execution_started":
			return { text: `${p.dim}  running…${p.reset}\n`, newline: true, prompt: false };
		case "tool_execution_succeeded":
			return { text: `  ok\n`, newline: true, prompt: false }; // v2a: plain — success is not an accent
		case "tool_execution_failed":
			return { text: `${p.red}  failed: ${escapeTerminal(ev.error.slice(0, 160))}${p.reset}\n`, newline: true, prompt: false };
		case "tool_result": {
			const content = typeof ev.content === "string" ? ev.content : ev.content.map((b) => (b.type === "text" ? b.text : "(image)")).join("");
			return {
				// v2b: the echo truncates at 160 chars + a /last hint — the
				// full content stays in the event stream.
				text: `${p.dim}${ev.isError ? p.red : p.dim}  [result${ev.isError ? " ✗" : ""}] ${foldResult(content)}${p.reset}\n`,
				newline: true,
				prompt: false,
			};
		}
		case "permission_requested":
			// round 8: the tool NAME is model text — escaped like everything else.
			return {
				text: `⏸ ${escapeTerminal(ev.name)} needs approval ${p.dim}${approvalDetail(ev.name, ev.input, resolvePath)}${p.reset} `,
				newline: false,
				prompt: true,
			};
		case "permission_decided":
			// v2a: verdicts are plain — neither success accents nor errors.
			return {
				text: `  ${ev.decision === "approved" ? "approved" : "denied"}${ev.reason ? `: ${escapeTerminal(ev.reason)}` : ""}\n`,
				newline: true,
				prompt: false,
			};
		case "terminal": {
			const outcome = ev.outcome;
			const label =
				outcome.kind === "completed"
					? `done` // v2a: plain — the ✓ mark is the success accent
					: outcome.kind === "aborted"
						? `aborted (${outcome.by})`
						: `${p.red}${outcome.kind}${p.reset}${"error" in outcome && "message" in outcome.error ? `: ${escapeTerminal((outcome.error as { message: string }).message.slice(0, 200))}` : ""}`;
			return { text: `\n${label}\n`, newline: true, prompt: false };
		}
		case "compacted":
			return { text: `${p.dim}  [compacted ${ev.cleared.length} results]${p.reset}\n`, newline: true, prompt: false };
		case "summarized":
			// ADR-0044: the /compact event is OFF-LOOP — it never appears in
			// a run stream; rendered for the switch's completeness only.
			return { text: `${p.dim}  [summarized up to seq ${ev.coversToSeq}]${p.reset}\n`, newline: true, prompt: false };
		case "uncertain_pending":
			return {
				text: `${p.red}⚠ ${escapeTerminal(ev.name)} failed (${ev.executionId}): ${escapeTerminal(ev.error.slice(0, 160))}${p.reset}\n`,
				newline: true,
				prompt: false,
			};
		case "checklist": {
			// ⑥: the durable checklist — the ▞ header accent (the recap's
			// brick) + one brick-glyph line per item. Static line content:
			// byte-identical in pipes and NO_COLOR.
			const lines = [`${p.bold}▞${p.reset} ${escapeTerminal(ev.header)}`];
			for (const item of ev.items) {
				const glyph = item.status === "pending" ? "□" : item.status === "active" ? "▖" : "▣";
				lines.push(`  ${glyph} ${escapeTerminal(item.text)}`);
			}
			return { text: `${lines.join("\n")}\n`, newline: true, prompt: false };
		}
		default:
			return { text: "", newline: false, prompt: false };
	}
}

/**
 * The approval prompt detail (Area 5/round 8): the human must be able to see
 * EVERYTHING they are approving. The shell command is shown in full; the
 * path is the CANONICAL one the tool will touch; write/edit show the FULL
 * content (never a truncated tail that hides a dangerous payload). The
 * decision is bound to the complete input via the decisionId.
 */
function approvalDetail(name: string, input: Record<string, unknown>, resolvePath: PathResolver): string {
	if (name === "shell") {
		return `\n  $ ${escapeTerminal(String(input.command ?? ""))}`;
	}
	if (name === "write_file") {
		const content = String(input.content ?? "");
		return `\n  ${escapeTerminal(resolvePath(String(input.path ?? "?")))}\n  ${escapeTerminal(content)}`;
	}
	if (name === "edit_file") {
		return `\n  ${escapeTerminal(resolvePath(String(input.path ?? "?")))}\n  replace: ${escapeTerminal(String(input.search ?? ""))}\n  with:    ${escapeTerminal(String(input.replace ?? ""))}`;
	}
	return `\n  ${escapeTerminal(JSON.stringify(input))}`;
}


/** B area: usage data gathered from the run's usage events. */
export interface RunUsage {
	readonly in: number | null;
	readonly out: number | null;
	readonly cache: number | null;
	readonly known: boolean;
}

/**
 * B area/v2a: the one-line status bar after a terminal, e.g.
 *   [turn 3 · in 12.4k out 1.8k · cache 9.2k · ctx ~14%]
 * Denoising: unknown fields are OMITTED ENTIRELY (show what there is); a fully unknown
 * usage → null (the caller prints nothing); faux mode → [turn N · faux].
 * All data comes from usage events; ctx is the approximate estimate
 * passed in (chars/4 vs the window), marked with ~.
 */
export function renderStatusLine(turn: number, usage: RunUsage, ctxRatio: number, faux = false): string | null {
	if (faux) return `[turn ${turn} · faux]`;
	if (!usage.known) return null; // everything unknown — nothing worth showing
	const parts: string[] = [];
	if (usage.in !== null || usage.out !== null) {
		const seg = `${usage.in !== null ? `in ${kUnit(usage.in)}` : ""}${usage.in !== null && usage.out !== null ? " " : ""}${usage.out !== null ? `out ${kUnit(usage.out)}` : ""}`;
		parts.push(seg);
	}
	if (usage.cache !== null) parts.push(`cache ${kUnit(usage.cache)}`);
	if (Number.isFinite(ctxRatio)) parts.push(`ctx ~${Math.round(ctxRatio * 100)}%`);
	if (parts.length === 0) return null;
	return `[turn ${turn} · ${parts.join(" · ")}]`;
}


/** v3 §02 — the recap line that ends a run, replacing the "done" label +
 *  the old status line. All fields derive LOCALLY from the event stream
 *  (zero tokens): wall seconds, tool counts, usage, cache hit %, ctx left.
 */
export interface RecapStats {
	readonly seconds: number;
	readonly tools: number;
	readonly edits: number;
	readonly usage: RunUsage;
	/** R-C item 4: the per-turn cache miss (min(prevIn, in) − cacheRead),
	 *  passed only when above the noise floor — the re-sent-uncached
	 *  prefix. Absent → the recap bytes stay the historical form. */
	readonly missed?: number;
	readonly ctxLeftPct: number | null; // 0..100, null when unknowable
	/** W19 — the mode the turn ran under. Under "plan" the recap becomes
	 *  the way-forward row (the claimed shape): a plan turn's currency is
	 *  the plan, not the tool count — the timing and tool-count parts
	 *  drop, and the two /mode hints replace them. */
	readonly mode?: string;
}

export function renderRecap(s: RecapStats): string {
	const p = palette();
	// W19: under plan the recap is the way out of the mode — the header
	// names the mode's posture, the hints name the exits (the ONLY
	// controls — /mode is the only way to leave plan mode).
	if (s.mode === "plan") {
		const parts = ["plan ready", "/mode default executes", "/mode accept-edits auto-approves edits"];
		if (s.ctxLeftPct !== null) parts.push(`ctx left ~${Math.round(s.ctxLeftPct)}%`);
		return `${p.bold}▞${p.reset} ${parts.join(" · ")}\n`;
	}
	const parts = [`${s.seconds}s`, `${s.tools} tool${s.tools === 1 ? "" : "s"}${s.edits > 0 ? ` (${s.edits} edit${s.edits === 1 ? "" : "s"})` : ""}`];
	if (s.usage.known) {
		const seg = `${s.usage.in !== null ? `in ${kUnit(s.usage.in)}` : ""}${s.usage.in !== null && s.usage.out !== null ? " " : ""}${s.usage.out !== null ? `out ${kUnit(s.usage.out)}` : ""}`;
		if (seg !== "") parts.push(seg);
		if (s.usage.cache !== null && s.usage.in !== null && s.usage.in > 0) {
			const hit = `cache ${Math.round((s.usage.cache / s.usage.in) * 100)}%`;
			parts.push(s.missed !== undefined && s.missed > 0 ? `${hit} · miss ${kUnit(s.missed)}` : hit);
		}
	}
	if (s.ctxLeftPct !== null) parts.push(`ctx left ~${Math.round(s.ctxLeftPct)}%`);
	return `${p.bold}▞${p.reset} ${parts.join(" · ")}\n`;
}

/** One-line summary of a session, for `kiso sessions`. */
export function renderSessionLine(meta: { id: string; title: string; events: number; runs: number; updatedAt: number }): string {
	const when = meta.updatedAt ? new Date(meta.updatedAt).toISOString().slice(0, 16) : "—";
	// round 8: the title is the user's first prompt — model/user text, escaped.
	return `${meta.id.padEnd(24)} ${meta.runs} runs ${String(meta.events).padStart(5)} events  ${when}  ${escapeTerminal(meta.title)}`;
}
