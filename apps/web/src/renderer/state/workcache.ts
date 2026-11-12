import type { Item, State } from "./model.js";
import type { Session } from "./store.js";
import type { View } from "./view.js";

/**
 * A few Works' page state, kept so that switching back shows one at once. It holds the reducer's built state (turns and their items), no
 * raw events, no React trees, and no connection: only the shown Work holds a stream (`Session.attach`/`detach`). Least recently shown
 * goes first, by count and by an estimate of the memory the states hold; the Work being shown is never dropped. A Work is its folder's
 * key AND its id: two folders can hold a Work of the same id.
 */
export const MAX_WORKS = 20;
export const MAX_BYTES = 64 * 1024 * 1024;

export const slotOf = (key: string | null, sessionId: string): string => `${key ?? ""}\0${sessionId}`;

/** What the strings of a value weigh, shallowly (the arguments of a tool call can be a whole file). */
const sizeOf = (v: unknown): number => (typeof v === "string" ? v.length : v !== null && typeof v === "object" ? Object.values(v).reduce<number>((n, x) => n + (typeof x === "string" ? x.length : 16), 16) : 16);

const itemBytes = (i: Item): number => {
	if (i.kind === "thinking" || i.kind === "text") return 120 + i.text.length;
	if (i.kind === "step") return 300 + i.name.length + sizeOf(i.input) + (i.error?.length ?? 0) + (i.output === null ? 0 : 150 + i.output.head.reduce((n, l) => n + l.length, 0));
	return 200 + sizeOf((i as { input?: unknown }).input);
};

/** An estimate, in bytes, of what a Work's state holds: its text and the counts of its items (UTF-16, so two bytes a character). */
export function weigh(state: State): number {
	let chars = 0;
	for (const turn of state.turns) {
		chars += 400 + turn.user.length + (turn.detail?.length ?? 0);
		for (const item of turn.items) chars += itemBytes(item);
	}
	return chars * 2 + state.tasks.length * 600;
}

/** What an unsent line holds (a picture is its base64). */
const draftBytes = (v: View): number => (v.draft === null ? 0 : v.draft.text.length * 2 + v.draft.attached.reduce((n, a) => n + (a.kind === "image" ? a.data.length : a.text.length) * 2, 0));

export class WorkCache {
	readonly #held = new Map<string, { readonly session: Session; bytes: number }>();
	readonly #max: number;
	readonly #budget: number;

	constructor(max = MAX_WORKS, budget = MAX_BYTES) {
		this.#max = max;
		this.#budget = budget;
	}

	/** The Work's session: the held one (now the most recently shown), else a new one from `make`; the others over the limits go. */
	acquire(slot: string, make: () => Session): Session {
		let entry = this.#held.get(slot);
		if (entry === undefined) entry = { session: make(), bytes: 0 };
		this.#held.delete(slot);
		this.#held.set(slot, entry);
		let total = 0;
		for (const e of this.#held.values()) total += e.bytes;
		for (const [key, e] of this.#held) {
			if (key === slot || (this.#held.size <= this.#max && total <= this.#budget)) break;
			e.session.detach();
			total -= e.bytes;
			this.#held.delete(key);
		}
		return entry.session;
	}

	/** The Work was left: what it holds is weighed again (it grew or shrank while it was shown). */
	release(slot: string): void {
		const e = this.#held.get(slot);
		if (e !== undefined) e.bytes = weigh(e.session.state) + draftBytes(e.session.view);
	}

	/** The Work is gone (deleted): nothing of it is kept. */
	drop(slot: string): void {
		this.#held.get(slot)?.session.detach();
		this.#held.delete(slot);
	}

	stats(): { readonly works: number; readonly bytes: number } {
		let bytes = 0;
		for (const e of this.#held.values()) bytes += e.bytes;
		return { works: this.#held.size, bytes };
	}
}

export const workCache = new WorkCache();
