/**
 * The ergonomics batch B4 (pure move) — resume: the RECOVERY flow (Area 2/7). The body
 * moved verbatim from index.ts.
 */

import { idleStatus, runningStatus, type RunUsage } from "@vincemakes/kiso-tui";
import type { AgentSession } from "@vincemakes/kiso-runtime";
import { getMode } from "./mode.js";
import { agentModel, dock, type LineInput } from "./state.js";
import { pendingAsk, resolveUncertains } from "./trust-ui.js";
import { failOnFauxExhaustion } from "./faux-glue.js";
import { consumeRun, estimateCtxRatio, startStatusSpinner } from "./chat.js";

/**
 * Resume = the RECOVERY flow (Area 2/7): uncertain executions are decided,
 * the interrupted run is continued via session.resume() — never faked with
 * a new prompt. An optional prompt afterwards starts a genuinely new turn.
 * E group: SIGINT aborts the run being resumed; every exit path closes the
 * session store so no lock is left behind.
 */
export async function resume(session: AgentSession, prompt: string | undefined, faux: boolean, input: LineInput): Promise<void> {
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;
	let turnNo = 0;
	// v3 §03: the two-state status bar (see chat — same shapes).
	let runUsage: RunUsage = { in: null, out: null, cache: null, known: false };
	let runGlyph = "▖";
	let runStart = Date.now();
	// KC2 §5: the rows the REPL and this flow used to build separately are
	// ONE formatter now — the running row was duplicated verbatim.
	const statusCb = (u: RunUsage, ctx: number): void => {
		runUsage = u;
		if (dock.active) dock.setStatus(runningStatus(runGlyph, runStart, u.out, ctx));
	};
	// the recovery flow prints the BARE mode (chat spells plan's posture) —
	// the extraction keeps that difference, it was not asked to settle it.
	const paintIdle = (): void => {
		if (dock.active) dock.setStatus(idleStatus(getMode(), agentModel, estimateCtxRatio(session)));
	};
	const withRun = async (run: ReturnType<AgentSession["resume"]>): Promise<void> => {
		currentRun = run;
		runStart = Date.now();
		runUsage = { in: null, out: null, cache: null, known: false };
		const stopSpinner = startStatusSpinner((g) => {
			runGlyph = g;
			statusCb(runUsage, estimateCtxRatio(session));
		});
		try {
			turnNo += 1;
			const last = await consumeRun(session, run, input, turnNo, faux, statusCb);
			failOnFauxExhaustion(last, faux, input);
		} finally {
			stopSpinner();
			paintIdle();
			currentRun = null;
		}
	};
	input.onSigint(() => {
		if (currentRun) {
			// round 8: Ctrl+C cancels the pending question AND the run.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (!cancelled) {
			// round 4 (adversarial): also unblock a pending startup question — the
			// readline close alone would leave ask() hanging forever.
			// round 5 (P2-2): the cancellation is recorded so the recovery is
			// NOT started afterwards — Ctrl+C exits cleanly.
			cancelled = true;
			console.log("\n[exit requested]");
			pendingAsk?.();
			input.close();
		}
	});
	input.onEot(() => {
		if (!currentRun && !cancelled && input.line() === "") {
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
	try {
		await resolveUncertains(session, input, () => cancelled);
		if (!cancelled) {
			await withRun(session.resume());
			if (prompt !== undefined && prompt !== "") {
				await withRun(session.run(prompt));
			}
		}
	} finally {
		input.close();
	}
}
