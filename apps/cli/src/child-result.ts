/**
 * ADR-0058 3d — how a background child ends: `kiso chat <id> --task-file
 * <f> --max-turns N --result-file <r>`.
 *
 * The budget (D6) is the session's `maxTurns`: the kernel stops the run at
 * a model boundary, after the round's tool results, before the next
 * request — nothing is killed. Such a run usually ends on a tool round with
 * no answer, so the child gets ONE wrap-up request: a system input naming
 * the spent budget, in a run limited to that one request. The outcome is
 * then `incomplete`, never a plain failure.
 *
 * The answer is the child's own — the last assistant text in its session's
 * projection, never its printed output — written atomically to `<r>`
 * (result.md), then the result record beside it (result.json), before the
 * process exits: the runner records the exit after both exist.
 *
 * 0.49.0 (I5, I6): the record COMMITS the result — result.md is read only
 * beside it — and it says everything the parent shows: how the run ended
 * (`endedBy`, the main run's terminal: a wrap-up is a second run, and the
 * parent never counts runs to learn it), the requests, the tool calls and
 * usage over the committed events, the model it ran on, and a failure's
 * error. Foreground children carry a result file too, so both ways of
 * waiting read the same record.
 */

import { renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentSession } from "@vincemakes/kiso-runtime";

export interface ChildEnd {
	readonly maxTurns?: number;
	readonly resultFile?: string;
}

export const wrapUpInput = (budget: number): string =>
	`Your turn budget of ${budget} model requests is spent. Answer now from what you have found, without further tool calls. End with the UNRESOLVED section, naming what you did not get to.`;

type Outcome = "completed" | "incomplete" | "failed";

interface TerminalOutcome {
	readonly kind: string;
	readonly error?: { readonly code?: string; readonly message?: string };
}

export async function finishChild(session: AgentSession, end: ChildEnd): Promise<void> {
	const lastTerminal = (): TerminalOutcome | undefined => {
		const t = [...session.log.all].reverse().find((e) => e.type === "terminal");
		return t === undefined ? undefined : (t as unknown as { outcome: TerminalOutcome }).outcome;
	};
	const lastOutcome = (): string | undefined => lastTerminal()?.kind;
	const main = lastTerminal();
	let outcome: Outcome = lastOutcome() === "completed" ? "completed" : "failed";
	if (end.maxTurns !== undefined && lastOutcome() === "max_turns") {
		for await (const _ of session.run(wrapUpInput(end.maxTurns), { source: "system", maxTurns: 1 })) {
			// drained: the wrap-up's events are durable in the session
		}
		outcome = "incomplete";
	}
	if (end.resultFile === undefined) return;
	const answer = lastAnswer(session);
	const requests = session.log.all.filter((e) => e.type === "stop").length;
	const events = committed(session.log.all as unknown as readonly LogEvent[]);
	const usages = events.filter((e) => e.type === "usage");
	const sum = (k: string): number => usages.reduce((n, e) => n + (typeof e[k] === "number" ? (e[k] as number) : 0), 0);
	const error = outcome === "failed" ? errorOf(lastTerminal()) : undefined;
	const record = {
		outcome,
		endedBy: main?.kind ?? "none",
		requests,
		...(end.maxTurns !== undefined ? { budget: end.maxTurns } : {}),
		toolCalls: events.filter((e) => e.type === "tool_call_end").length,
		usage: {
			completedResponses: usages.length,
			abandonedAttempts: session.log.all.filter((e) => e.type === "model_output_abandoned").length,
			inputTokens: sum("inputTokens"),
			outputTokens: sum("outputTokens"),
			cacheRead: sum("cacheRead"),
		},
		model: session.model,
		profile: session.profileName,
		...(error !== undefined ? { error } : {}),
	};
	writeAtomic(end.resultFile, answer === "" ? "" : `${answer}\n`);
	// I5: the record last — it commits the answer written above
	writeAtomic(join(dirname(end.resultFile), "result.json"), `${JSON.stringify(record)}\n`);
	// the runner's terminal is the exit: a failed child must not read as a clean one
	if (outcome === "failed") process.exitCode = 1;
}

interface LogEvent {
	readonly type: string;
	readonly seq?: number;
	readonly voidFromSeq?: number;
	readonly [k: string]: unknown;
}

/** The kernel's void scope (core `project.ts`): a `model_output_abandoned`
 *  marker voids (voidFromSeq, seq], an abandoned draft's events. A voided
 *  tool call never ran and a voided usage was never billed as an answer. */
function committed(events: readonly LogEvent[]): LogEvent[] {
	const voids = events.filter((e) => e.type === "model_output_abandoned").map((e) => ({ from: e.voidFromSeq ?? -1, to: e.seq ?? -1 }));
	return events.filter((e) => !voids.some((r) => (e.seq ?? -1) > r.from && (e.seq ?? -1) <= r.to));
}

/** A failed run's reason, one line: the kernel's error, or how it ended. */
function errorOf(t: TerminalOutcome | undefined): string {
	if (t === undefined) return "the run left no terminal";
	if (t.kind === "error" && t.error !== undefined) return [t.error.code, t.error.message].filter((s) => s !== undefined && s !== "").join(": ") || "error";
	return `the run ended with ${t.kind}`;
}

/** The last assistant message's text in the session's projection. */
function lastAnswer(session: AgentSession): string {
	const messages = session.projected();
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i]!;
		if (m.role !== "assistant") continue;
		const text = m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
		if (text.trim() !== "") return text.trimEnd();
	}
	return "";
}

function writeAtomic(path: string, content: string): void {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content, "utf8");
	renameSync(tmp, path);
}
