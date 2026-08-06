/**
 * 手感批 B4 (pure move) — resume: the RECOVERY flow (Area 2/7). The body
 * moved verbatim from index.ts.
 */

import { kUnit, type RunUsage } from "@vincemakes/kiso-tui";
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
 * E 组: SIGINT aborts the run being resumed; every exit path closes the
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
	const statusCb = (u: RunUsage, ctx: number): void => {
		runUsage = u;
		if (!dock.active) return;
		const pct = Number.isFinite(ctx) ? Math.round((1 - ctx) * 100) : null;
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
			const last = await consumeRun(session, run, input, turnNo, faux, null, statusCb);
			failOnFauxExhaustion(last, faux, input);
		} finally {
			stopSpinner();
			paintIdle();
			currentRun = null;
		}
	};
	input.onSigint(() => {
		if (currentRun) {
			// 八: Ctrl+C cancels the pending question AND the run.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (!cancelled) {
			// 第四轮(对抗): also unblock a pending startup question — the
			// readline close alone would leave ask() hanging forever.
			// 第五轮(P2-2): the cancellation is recorded so the recovery is
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
