import { ClientError, createClient, type SessionClient } from "@vincemakes/kiso-client";
import type { WireInput } from "@vincemakes/kiso-protocol";
import { initialState, reduce, type Input, type State } from "./model.js";
import { fmt, t } from "../i18n/index.js";
import { unadmittedInput } from "./unadmitted.js";

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
	/** the log as the host had it when the Work opened has been drawn (until then the page shows that it is loading) */
	readonly loaded: () => boolean;
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

export function openSession(options: { readonly baseUrl: string; readonly sessionId: string }): Session {
	const client = createClient({ baseUrl: options.baseUrl });
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
	// the replay is caught up once the stream has reached the last event the host had when the Work opened
	let lastSeq = -1;
	let target: number | null = null;
	let loaded = false;
	// refreshes overlap (the page's load, an action, an event): only the answer to the latest question counts, or an early answer
	// arriving late (the run not started yet) would hide a live run (no Stop beside an approval)
	let asked = 0;
	const refresh = async (): Promise<void> => {
		const mine = (asked += 1);
		try {
			const snapshot = await api.state();
			if (mine !== asked) return;
			target ??= snapshot.highWater;
			loaded ||= lastSeq >= target;
			push({ kind: "snapshot", state: snapshot });
		} catch (error) {
			// the host answered with a refusal (no model is set up yet): there is nothing to load, and the page shows why
			if (error instanceof ClientError && !loaded) {
				loaded = true;
				push({ kind: "frame", name: "message", data: message });
			}
			// the host is away; the stream reconnects and asks again
		}
	};
	const ctl = new AbortController();
	void refresh();
	const handedBack = new Set<string>();
	/** Input a steer handed to a run that never admitted it is the person's next message: a new run. A frame can be replayed
	 *  (a reconnect, a reload), so it counts only while its terminal is still the last event on the log. */
	const startUnadmitted = async (data: { readonly runId: string; readonly items: readonly WireInput[] }, terminalSeq: number, stopped: boolean): Promise<void> => {
		const input = unadmittedInput(data.items);
		if (input === null || handedBack.has(data.runId)) return;
		handedBack.add(data.runId);
		// a stop is not a send: the person's added line is not run behind their back, and not lost silently either
		if (stopped) return say(fmt(t.notSent, { line: typeof input === "string" ? input : "" }));
		try {
			if ((await api.state()).highWater === terminalSeq) await act(() => api.run(input));
		} catch {
			handedBack.delete(data.runId);
		}
	};
	void (async () => {
		let stopped = false;
		for await (const ev of api.events({ signal: ctl.signal, onReconnect: () => void setTimeout(refresh, 600) })) {
			if (ev.kind === "event") {
				lastSeq = ev.event.seq;
				loaded ||= target !== null && lastSeq >= target;
				if (ev.event.type === "terminal") stopped = ev.event.outcome.kind === "aborted";
				push({ kind: "event", event: ev.event });
				if (ev.event.type === "terminal" || ev.event.type === "user_input") void refresh();
			} else if (ev.kind === "frame") {
				push({ kind: "frame", name: ev.event, data: ev.data });
				if (ev.event === "unadmitted") void startUnadmitted(ev.data as Parameters<typeof startUnadmitted>[0], lastSeq, stopped);
			}
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
		loaded: () => loaded,
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

/** What the page was opened with: the one-time connect code in the address fragment is read once and removed at once. */
export function launchParams(): { code: string | null; sessionId: string | null; auto: string | null } {
	const params = new URLSearchParams(location.hash.slice(1));
	history.replaceState(null, "", location.pathname);
	return { code: params.get("c"), sessionId: params.get("session"), auto: params.get("input") };
}
