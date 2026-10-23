import { ClientError, createClient, type SessionClient } from "@vincemakes/kiso-client";
import { initialState, reduce, type Input, type State } from "./model.js";
import { t } from "../i18n/index.js";

/**
 * The page's one connection to the host: a long-lived event stream into the
 * model, and what a person can do (send, add a line, stop, answer an
 * approval, resume an interrupted run, give a verdict on an execution that
 * may or may not have happened). Inputs are queued and applied once per
 * animation frame, so a burst of thinking deltas is one render.
 */

export interface Session {
	readonly state: State;
	readonly subscribe: (listener: () => void) => () => void;
	readonly version: () => number;
	/** a short message for the person (a refused stop), or null */
	readonly message: () => string | null;
	readonly send: (text: string) => Promise<void>;
	readonly steer: (text: string) => Promise<void>;
	readonly abort: () => Promise<void>;
	readonly approve: (decisionId: string, allow: boolean) => Promise<void>;
	readonly resume: () => Promise<void>;
	readonly verdict: (executionId: string, resolution: "rerun" | "abandoned") => Promise<void>;
	readonly stop: () => void;
}

export function openSession(options: { readonly baseUrl: string; readonly token: string; readonly sessionId: string }): Session {
	const client = createClient({ baseUrl: options.baseUrl, headers: () => ({ authorization: `Bearer ${options.token}` }) });
	const api: SessionClient = client.session(options.sessionId);
	const state = initialState();
	const listeners = new Set<() => void>();
	let queue: Input[] = [];
	let scheduled = false;
	let message: string | null = null;
	let messageTimer: ReturnType<typeof setTimeout> | undefined;
	const flush = (): void => {
		scheduled = false;
		const batch = queue;
		queue = [];
		for (const input of batch) reduce(state, input);
		for (const l of listeners) l();
	};
	const push = (input: Input): void => {
		queue.push(input);
		if (!scheduled) {
			scheduled = true;
			requestAnimationFrame(flush);
		}
	};
	const say = (text: string): void => {
		message = text;
		clearTimeout(messageTimer);
		messageTimer = setTimeout(() => {
			message = null;
			push({ kind: "frame", name: "message", data: null });
		}, 5_000);
		push({ kind: "frame", name: "message", data: text });
	};
	/** Ask the host what it knows: an open run, uncertain executions, whether a run is live. */
	const refresh = async (): Promise<void> => {
		try {
			push({ kind: "snapshot", state: await api.state() });
		} catch {
			// the host is away; the stream reconnects and asks again
		}
	};
	const ctl = new AbortController();
	void refresh();
	void (async () => {
		for await (const ev of api.events({ signal: ctl.signal, onReconnect: () => void setTimeout(refresh, 600) })) {
			if (ev.kind === "event") {
				push({ kind: "event", event: ev.event });
				if (ev.event.type === "terminal" || ev.event.type === "user_input") void refresh();
			} else if (ev.kind === "frame") push({ kind: "frame", name: ev.event, data: ev.data });
		}
	})();
	const act = async (fn: () => Promise<unknown>): Promise<void> => {
		try {
			await fn();
		} finally {
			void refresh();
		}
	};
	const resume = (): Promise<void> => act(() => api.resume());
	return {
		state,
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		version: () => state.version,
		message: () => message,
		// an open run is resumed to its end first: the new line is not lost and the old run is not abandoned
		send: (text) => act(() => api.run(text, state.snapshot?.openRun != null && !state.snapshot.running ? { resumeFirst: true } : {})),
		steer: (text) =>
			act(async () => {
				try {
					await api.steer(text);
				} catch (e) {
					// no run to join, or it was already closing: the line starts a run of its own
					if (e instanceof ClientError && (e.code === "idle" || e.code === "closed")) await api.run(text);
					else throw e;
				}
			}),
		abort: () =>
			act(async () => {
				const reply = await api.abort();
				if (reply.kind === "parked") say(t.parked);
			}),
		approve: (decisionId, allow) =>
			act(async () => {
				const reply = await api.approve(decisionId, allow);
				if (reply.needsResume) await api.resume(); // the run that asked is gone: the answer is on the log, resuming continues it
			}),
		resume,
		verdict: (executionId, resolution) =>
			act(async () => {
				const reply = await api.resolveUncertain(executionId, resolution);
				if (reply.remaining === 0) await api.resume(); // the last verdict is in: the run can go on
			}),
		stop: () => ctl.abort(),
	};
}

/** What the page was opened with: the token in the address fragment is read once and removed. */
export function launchParams(): { token: string; sessionId: string | null; auto: string | null } {
	const params = new URLSearchParams(location.hash.slice(1));
	history.replaceState(null, "", location.pathname);
	return { token: params.get("token") ?? "", sessionId: params.get("session"), auto: params.get("input") };
}
