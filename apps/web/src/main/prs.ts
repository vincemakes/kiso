import { tryRun } from "./git.js";

/**
 * The pull request a Work made (plan PR C, owner 2026-11-04: per Work, the way the reference desktop app keeps it per session): several
 * Works share a folder and its branch, so the branch's PR says nothing about which Work it belongs to. A Work's PR is the one its own
 * `gh pr create` call printed, the one the rail's Create PR opened for it, or the one the person linked by hand. Its state is asked of
 * `gh` at most once a minute per PR, off the request: a row shows the last state known.
 */
export interface Pr {
	readonly number: number;
	readonly url: string;
}

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/;

/** The last pull request URL in a text (a command's output: what it quoted comes before what it made). */
export const lastPrOfText = (text: string): Pr | null => {
	const all = [...text.matchAll(new RegExp(PR_URL, "g"))];
	const m = all.at(-1);
	return m === undefined ? null : { number: Number(m[1]), url: m[0] };
};

export const prOfUrl = (text: string): Pr | null => {
	const m = PR_URL.exec(text);
	return m === null ? null : { number: Number(m[1]), url: m[0] };
};

interface Ev {
	readonly type: string;
	readonly callId?: string;
	readonly input?: unknown;
	readonly content?: unknown;
}

/** The last PR a `gh pr create` call of these events printed, if any. */
export function prOfEvents(events: readonly Ev[]): Pr | null {
	const calls = new Set(events.filter((e) => e.type === "tool_call_end" && JSON.stringify(e.input ?? "").includes("gh pr create")).map((e) => e.callId));
	let found: Pr | null = null;
	for (const e of events) if (e.type === "tool_result" && calls.has(e.callId)) found = prOfUrl(typeof e.content === "string" ? e.content : JSON.stringify(e.content ?? "")) ?? found;
	return found;
}

export type PrState = "OPEN" | "MERGED" | "CLOSED";
const FRESH_MS = 60_000;

export class PrStates {
	readonly #known = new Map<string, { state?: PrState; at: number }>();

	/** The last state known (none yet: asked now, in the background). */
	stateOf(url: string): PrState | undefined {
		const held = this.#known.get(url);
		if (held === undefined || Date.now() - held.at > FRESH_MS) {
			this.#known.set(url, { ...(held?.state !== undefined ? { state: held.state } : {}), at: Date.now() });
			void tryRun(process.cwd(), "gh", ["pr", "view", url, "--json", "state", "--jq", ".state"], 8000).then((s) => {
				if (s === "OPEN" || s === "MERGED" || s === "CLOSED") this.#known.set(url, { state: s, at: Date.now() });
			});
		}
		return held?.state;
	}
}
