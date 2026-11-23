import createAskExtension from "@vincemakes/kiso-ask-ext";
import type { KisoExtension } from "@vincemakes/kiso-core";

/**
 * ADR-0062 § 10c, PR 7: `ask_user` in kiso web. The extension registers its tool only for a host that gives it `ui.ask`; this
 * is the web's. A question waits here under its Work and call until the page answers it (`/desk/ask`); nothing else is
 * stored, because the call is durable as its tool_call_end and the answer as its tool_result (the extension's own rule).
 * The page draws the card from the log: a call with no result. Stop aborts the wait through the run's signal.
 */

type Signal = { readonly aborted?: boolean; readonly addEventListener?: (type: "abort", listener: () => void, options?: { once?: boolean }) => void };

/** ADR-0062 § 10c.1: what the model reads when a line from another session ends its waiting question. */
const REPLACED = "Not answered: another session sent this Work a message while the question waited, so it is withdrawn, not declined by the person. Read the message, then call ask_user again with the questions you still need (the card keeps the person's unchanged picks).";
/** § 10c.1: at most this many questions a run's incoming lines may end; past it, lines wait for the answer as before. */
const PER_RUN = 3;

export class AskBridge {
	readonly #waiting = new Map<string, { readonly resolve: (result: unknown) => void; readonly questions: readonly string[]; readonly run: object }>();
	readonly #ended = new WeakMap<object, number>();

	readonly ui = {
		ask: (spec: unknown, signal: Signal | undefined, ctx: { readonly sessionId?: string; readonly callId?: string }): Promise<unknown> =>
			new Promise((resolve, reject) => {
				const key = `${ctx.sessionId}/${ctx.callId}`;
				const questions = ((spec as { questions?: readonly { question?: unknown }[] }).questions ?? []).map((q) => String(q.question ?? ""));
				this.#waiting.set(key, { resolve, questions, run: signal ?? this });
				signal?.addEventListener?.("abort", () => (this.#waiting.delete(key), reject(new Error("the run was stopped"))), { once: true });
			}),
	};

	/** The page's answer: `{ answers }`, `{ declined }`, or both (some questions skipped). False when nothing waits there. */
	answer(sessionId: string, callId: string, result: unknown): boolean {
		const r = result as { answers?: unknown; declined?: unknown } | null;
		const resolve = this.#waiting.get(`${sessionId}/${callId}`)?.resolve;
		if (resolve === undefined || r === null || typeof r !== "object" || !(Array.isArray(r.answers) || Array.isArray(r.declined))) return false;
		this.#waiting.delete(`${sessionId}/${callId}`);
		resolve(r);
		return true;
	}

	/**
	 * ADR-0062 § 10c.1: a line from another session was accepted by the Work's live run, which is inside this question's tool
	 * call and cannot admit it. The question ends with the "not answered" shape and a reason to ask again; the line is then
	 * admitted at the next boundary. One per question (it is over once ended) and PER_RUN per run. False: nothing waits, or the
	 * run's allowance is spent (the line waits for the person's answer, as it did before).
	 */
	replaceWaiting(sessionId: string): boolean {
		for (const [key, w] of this.#waiting) {
			if (!key.startsWith(`${sessionId}/`)) continue;
			const n = this.#ended.get(w.run) ?? 0;
			if (n >= PER_RUN) return false;
			this.#ended.set(w.run, n + 1);
			this.#waiting.delete(key);
			w.resolve({ declined: w.questions, replaced: true, reason: REPLACED });
			return true;
		}
		return false;
	}

	/** Whether a question of this Work waits for the person (the sidebar shows it as waiting). */
	waiting(sessionId: string): boolean {
		for (const key of this.#waiting.keys()) if (key.startsWith(`${sessionId}/`)) return true;
		return false;
	}

	extension(): Promise<KisoExtension> {
		// the extension types its signal as `{ aborted }`; the run hands the tool its AbortSignal, which can be listened to
		return createAskExtension(this.ui as unknown as Parameters<typeof createAskExtension>[0]) as Promise<KisoExtension>;
	}
}
