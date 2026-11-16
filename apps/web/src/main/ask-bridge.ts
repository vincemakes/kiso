import createAskExtension from "@vincemakes/kiso-ask-ext";
import type { KisoExtension } from "@vincemakes/kiso-core";

/**
 * ADR-0062 § 10c, PR 7: `ask_user` in kiso web. The extension registers its tool only for a host that gives it `ui.ask`; this
 * is the web's. A question waits here under its Work and call until the page answers it (`/desk/ask`); nothing else is
 * stored, because the call is durable as its tool_call_end and the answer as its tool_result (the extension's own rule).
 * The page draws the card from the log: a call with no result. Stop aborts the wait through the run's signal.
 */

type Signal = { readonly aborted?: boolean; readonly addEventListener?: (type: "abort", listener: () => void, options?: { once?: boolean }) => void };

export class AskBridge {
	readonly #waiting = new Map<string, (result: unknown) => void>();

	readonly ui = {
		ask: (_spec: unknown, signal: Signal | undefined, ctx: { readonly sessionId?: string; readonly callId?: string }): Promise<unknown> =>
			new Promise((resolve, reject) => {
				const key = `${ctx.sessionId}/${ctx.callId}`;
				this.#waiting.set(key, resolve);
				signal?.addEventListener?.("abort", () => (this.#waiting.delete(key), reject(new Error("the run was stopped"))), { once: true });
			}),
	};

	/** The page's answer: `{ answers }`, `{ declined }`, or both (some questions skipped). False when nothing waits there. */
	answer(sessionId: string, callId: string, result: unknown): boolean {
		const r = result as { answers?: unknown; declined?: unknown } | null;
		const resolve = this.#waiting.get(`${sessionId}/${callId}`);
		if (resolve === undefined || r === null || typeof r !== "object" || !(Array.isArray(r.answers) || Array.isArray(r.declined))) return false;
		this.#waiting.delete(`${sessionId}/${callId}`);
		resolve(r);
		return true;
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
