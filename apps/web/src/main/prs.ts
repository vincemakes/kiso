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
const GH_AT_ONCE = 2;

/** What `gh` says of a pull request, as the rail's row shows it. */
export interface PrInfo {
	readonly state: PrState;
	readonly title: string;
	readonly additions: number;
	readonly deletions: number;
	readonly checks: { readonly done: number; readonly total: number; readonly failed: number };
}

export class PrStates {
	readonly #known = new Map<string, { info?: PrInfo; at: number }>();
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	/** The last answer known. A merged or closed pull request is asked once; an open one or one not yet answered at most once a minute, in the background, two `gh` at a time. */
	infoOf(url: string): PrInfo | undefined {
		const held = this.#known.get(url);
		if (held?.info !== undefined && held.info.state !== "OPEN") return held.info;
		if (held === undefined || Date.now() - held.at > FRESH_MS) {
			this.#known.set(url, { ...(held?.info !== undefined ? { info: held.info } : {}), at: Date.now() });
			void this.#ask(url);
		}
		return held?.info;
	}

	stateOf(url: string): PrState | undefined {
		return this.infoOf(url)?.state;
	}

	async #ask(url: string): Promise<void> {
		while (this.#active >= GH_AT_ONCE) await new Promise<void>((resolve) => this.#waiting.push(resolve));
		this.#active += 1;
		try {
			const json = await tryRun(process.cwd(), "gh", ["pr", "view", url, "--json", "state,title,additions,deletions,statusCheckRollup"], 8000);
			if (json === null) return;
			const p = JSON.parse(json) as { state?: string; title?: string; additions?: number; deletions?: number; statusCheckRollup?: readonly { status?: string; conclusion?: string }[] };
			if (p.state !== "OPEN" && p.state !== "MERGED" && p.state !== "CLOSED") return;
			const c = p.statusCheckRollup ?? [];
			this.#known.set(url, { info: { state: p.state, title: p.title ?? "", additions: p.additions ?? 0, deletions: p.deletions ?? 0, checks: { total: c.length, done: c.filter((x) => x.status === "COMPLETED").length, failed: c.filter((x) => x.conclusion === "FAILURE").length } }, at: Date.now() });
		} catch {
			// an answer that is not JSON is no answer: the row shows what the log said
		} finally {
			this.#active -= 1;
			this.#waiting.shift()?.();
		}
	}
}
