import { createClient, type SessionClient } from "@vincemakes/kiso-client";
import { initialState, reduce, type Input, type State } from "./model.js";

/**
 * The page's one connection to the host: a long-lived event stream into the
 * model, and the four things a person can do (send, add a line, stop,
 * answer an approval). Inputs are queued and applied once per animation
 * frame, so a burst of thinking deltas is one render.
 */

export interface Session {
	readonly state: State;
	readonly subscribe: (listener: () => void) => () => void;
	readonly version: () => number;
	readonly send: (text: string) => Promise<void>;
	readonly steer: (text: string) => Promise<void>;
	readonly abort: () => Promise<void>;
	readonly approve: (decisionId: string, allow: boolean) => Promise<void>;
	readonly stop: () => void;
}

export function openSession(options: { readonly baseUrl: string; readonly token: string; readonly sessionId: string }): Session {
	const client = createClient({ baseUrl: options.baseUrl, headers: () => ({ authorization: `Bearer ${options.token}` }) });
	const api: SessionClient = client.session(options.sessionId);
	const state = initialState();
	const listeners = new Set<() => void>();
	let queue: Input[] = [];
	let scheduled = false;
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
	const ctl = new AbortController();
	void (async () => {
		for await (const ev of api.events({ signal: ctl.signal })) {
			if (ev.kind === "event") push({ kind: "event", event: ev.event });
			else if (ev.kind === "frame") push({ kind: "frame", name: ev.event, data: ev.data });
		}
	})();
	return {
		state,
		subscribe: (l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		version: () => state.version,
		send: async (text) => void (await api.run(text)),
		steer: async (text) => void (await api.steer(text)),
		abort: async () => void (await api.abort()),
		approve: async (decisionId, allow) => void (await api.approve(decisionId, allow)),
		stop: () => ctl.abort(),
	};
}

/** What the page was opened with: the token in the address fragment is read once and removed. */
export function launchParams(): { token: string; sessionId: string; auto: string | null } {
	const params = new URLSearchParams(location.hash.slice(1));
	history.replaceState(null, "", location.pathname);
	return { token: params.get("token") ?? "", sessionId: params.get("session") ?? "main", auto: params.get("input") };
}
