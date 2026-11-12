import { ClientError, createClient, type ConnectionState, type SessionClient } from "@vincemakes/kiso-client";
import type { WireInput } from "@vincemakes/kiso-protocol";
import { initialState, reduce, type Input, type State } from "./model.js";
import { fmt, t } from "../i18n/index.js";
import { unadmittedInput } from "./unadmitted.js";
import { withNote } from "./envnote.js";

/**
 * A Work's page state and its connection to the host, kept apart: the state (the reducer's turns, the unsent bits of a conversation)
 * outlives the connection, so the page can keep a few Works' state and show one again at once. `attach` opens the one long-lived event
 * stream into the model (the shown Work holds it; a Work in the cache holds none), `detach` closes it. And what a person can do (send, add a line, stop, answer an
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
	/** the stream's connection, and since when it has not been open; one object per change */
	readonly link: () => { readonly state: ConnectionState; readonly since: number };
	/** dial again now (the button; the browser also does it when it is back online, visible or focused) */
	readonly retryNow: () => void;
	/** a line: text, or text with pictures and files (content blocks) */
	readonly send: (input: WireInput) => Promise<void>;
	readonly steer: (input: WireInput) => Promise<void>;
	readonly abort: () => Promise<void>;
	readonly approve: (decisionId: string, allow: boolean) => Promise<void>;
	readonly resume: () => Promise<void>;
	readonly verdict: (executionId: string, resolution: "rerun" | "abandoned") => Promise<void>;
	/** what is drawn is from before a switch away: until the host has been asked again, an approval or a running state in it is not current */
	readonly stale: () => boolean;
	/** open the stream: a first time it replays the log; after a detach it resumes from the last event the reducer applied */
	readonly attach: () => void;
	/** close the stream and apply what it brought, keeping the state */
	readonly detach: () => void;
}

export function openSession(options: { readonly baseUrl: string; readonly sessionId: string; /** the Work's folder key (null: the one in use) */ readonly key: string | null; readonly onRefused?: () => void }): Session {
	const client = createClient({ baseUrl: options.baseUrl });
	const api: SessionClient = client.session(options.sessionId);
	const state = initialState();
	const listeners = new Set<() => void>();
	let queue: Input[] = [];
	// the last event the reducer APPLIED (not merely received: the queue drains once a frame): where a stream resumes after a detach
	let applied = -1;
	let stale = false;
	let attached = false;
	let scheduled = false;
	let message: string | null = null;
	let messageTimer: ReturnType<typeof setTimeout> | undefined;
	const flush = (): void => {
		scheduled = false;
		const batch = queue;
		queue = [];
		for (const input of batch) {
			reduce(state, input);
			if (input.kind === "event") applied = input.event.seq;
		}
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
	// catching up ends when the stream reaches the host's high water at open: a durable seq, compared by value (not every durable event is
	// on the wire, so events are never counted). Until then a replayed user_input or terminal asks nothing; one read follows. An event
	// past that seq is live, whenever it arrives: a run that starts, or ends, during the catch-up is read at once.
	let caughtUp = false;
	const catchUp = (): void => {
		if (caughtUp || target === null || lastSeq < target) return;
		caughtUp = true;
		void refresh();
	};
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
			stale = false;
			catchUp();
		} catch (error) {
			// the host answered with a refusal (no model is set up yet): there is nothing to load, and the page shows why
			if (error instanceof ClientError && !loaded) {
				loaded = true;
				push({ kind: "frame", name: "message", data: message });
			}
			// the host is away; the stream reconnects and asks again
		}
	};
	let ctl: AbortController | null = null;
	let link = { state: { kind: "connecting" } as ConnectionState, since: Date.now() };
	const wake = (): void => (document.hidden ? undefined : api.retryNow());
	let stopped = false;
	const handedBack = new Set<string>();
	/** Input a steer handed to a run that never admitted it is the person's next message: a new run. A frame can be replayed
	 *  (a reconnect, a reload), so it counts only while its terminal is still the last event on the log. */
	const startUnadmitted = async (data: { readonly runId: string; readonly items: readonly WireInput[] }, terminalSeq: number, stopped: boolean): Promise<void> => {
		const input = unadmittedInput(data.items);
		if (input === null || handedBack.has(data.runId) || (target !== null && terminalSeq < target)) return; // a replayed old one: its terminal is not the last event
		handedBack.add(data.runId);
		// a stop is not a send: the person's added line is not run behind their back, and not lost silently either
		if (stopped) return say(fmt(t.notSent, { line: typeof input === "string" ? input : "" }));
		try {
			if ((await api.state()).highWater === terminalSeq) await act(() => api.run(input));
		} catch {
			handedBack.delete(data.runId);
		}
	};
	/** Open the stream. After a detach it resumes one event early: the last event applied is replayed with the frames that follow it (the
	 *  host replays an event with the frames beside it, and a cut can fall between the two), the event itself is skipped here and its
	 *  frames apply again, idempotently (`at` only when it still names the last event, usage, run_usage and tool_output assign, tasks
	 *  replace). Frames of earlier events are not replayed, so none applies twice. `tasks` comes afresh. */
	const attach = (): void => {
		if (ctl !== null) return;
		const mine = (ctl = new AbortController());
		stale = attached; // a first attach draws nothing yet; a later one starts from a past that the first read of the host replaces
		attached = true;
		target = null;
		caughtUp = false;
		link = { state: { kind: "connecting" } as ConnectionState, since: Date.now() };
		for (const e of ["online", "focus"]) addEventListener(e, wake);
		document.addEventListener("visibilitychange", wake);
		void refresh();
		void (async () => {
			for await (const ev of api.events({
				signal: mine.signal,
				after: Math.max(-1, applied - 1),
				paused: () => document.hidden,
				onState: (state) => {
					if (state.kind === "open" && link.state.kind !== "open") void refresh(); // back: ask again what the host knows
					if (state.kind === "refused" && state.status === 401) options.onRefused?.(); // only a lost sign-in is the whole page's; another 4xx ends this Work's stream
					link = { state, since: state.kind === "open" ? 0 : link.state.kind === "open" ? Date.now() : link.since };
					for (const l of listeners) l();
				},
			})) {
				if (ev.kind === "event") {
					if (ev.event.seq <= applied) continue; // the overlapping event: already drawn
					lastSeq = ev.event.seq;
					const live = caughtUp || (target !== null && lastSeq > target);
					loaded ||= target !== null && lastSeq >= target;
					if (ev.event.type === "terminal") stopped = ev.event.outcome.kind === "aborted";
					push({ kind: "event", event: ev.event });
					if (live && (ev.event.type === "terminal" || ev.event.type === "user_input")) void refresh();
					catchUp();
				} else if (ev.kind === "frame") {
					push({ kind: "frame", name: ev.event, data: ev.data });
					if (ev.event === "unadmitted") void startUnadmitted(ev.data as Parameters<typeof startUnadmitted>[0], lastSeq, stopped);
				}
			}
		})();
	};
	/** Close the stream, keeping the state: what it brought is applied first, so `applied` is where it really stood. */
	const detach = (): void => {
		if (ctl === null) return;
		flush();
		ctl.abort();
		ctl = null;
		removeEventListener("online", wake);
		removeEventListener("focus", wake);
		document.removeEventListener("visibilitychange", wake);
	};
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
		link: () => link,
		retryNow: () => api.retryNow(),
		// an open run is resumed to its end first: the new line is not lost and the old run is not abandoned
		send: (text) => act(() => api.run(withNote(options.key, options.sessionId, text), state.snapshot?.openRun != null && !state.snapshot.running ? { resumeFirst: true } : {})),
		steer: (text) =>
			act(async () => {
				try {
					await api.steer(withNote(options.key, options.sessionId, text));
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
		stale: () => stale,
		attach,
		detach,
	};
}

/** What the page was opened with: the one-time connect code in the address fragment is read once and removed at once. */
export function launchParams(): { code: string | null; sessionId: string | null; auto: string | null } {
	const params = new URLSearchParams(location.hash.slice(1));
	history.replaceState(null, "", location.pathname);
	return { code: params.get("c"), sessionId: params.get("session"), auto: params.get("input") };
}
