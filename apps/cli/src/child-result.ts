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
 * (result.md) with `{ outcome, requests, budget }` beside it (result.json),
 * before the process exits: the runner records the exit after both exist.
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

export async function finishChild(session: AgentSession, end: ChildEnd): Promise<void> {
	const lastOutcome = (): string | undefined => {
		const t = [...session.log.all].reverse().find((e) => e.type === "terminal");
		return t === undefined ? undefined : (t as { outcome: { kind: string } }).outcome.kind;
	};
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
	writeAtomic(end.resultFile, answer === "" ? "" : `${answer}\n`);
	writeAtomic(join(dirname(end.resultFile), "result.json"), `${JSON.stringify({ outcome, requests, ...(end.maxTurns !== undefined ? { budget: end.maxTurns } : {}) })}\n`);
	// the runner's terminal is the exit: a failed child must not read as a clean one
	if (outcome === "failed") process.exitCode = 1;
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
