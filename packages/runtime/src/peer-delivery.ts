import type { Event, UserInputVia } from "@vincemakes/kiso-core";
import { readInbox, removeMessage, type PeerMessage } from "./inbox.js";
import type { PeerInput, Run } from "./run.js";

/**
 * ADR-0062 § 3: messages from other sessions reach the model, the way task notices do (tasks/delivery.ts). One delivery per
 * session, reading its inbox when poked (a message was written, the session opened, a run settled):
 *   a live run      → `run.deliver`, each message its own input at the next safe point;
 *   an idle session → one wake run whose first input is the oldest message; the rest ride its first admission.
 * Exactly once, from the log: a message counts as admitted when a user_input whose `via.messageId` names it is in the log;
 * only then is its inbox file deleted. Handed to a run but not yet in the log is remembered, so nothing is handed twice.
 * A wake spends one of its chain's wakes (`mayWake`); once they are spent the message waits for the next run. A held
 * message is never delivered until the person releases it.
 */

/** ADR-0062: what became of a message when its receiver looked. */
export type PeerOutcome = "handed" | "woke" | "waiting";

export interface PeerDeliveryOptions {
	readonly root: string;
	readonly sessionId: string;
	readonly events: () => readonly Event[];
	readonly liveRun: () => Run | undefined;
	/** Start ONE run whose first input is this message. Absent: messages wait for the next run. */
	readonly onWake?: (input: { readonly content: string; readonly via: UserInputVia }) => void;
	/** ADR-0062 § 6: spend one of the chain's wakes; false: the chain's budget is spent, the message waits for a run */
	readonly mayWake?: (rootId: string) => boolean;
}

/** What the model reads: who sent it, the text, and the files as paths with their revisions when sent (the receiver reads
 *  them with its own tools; a read printing another revision is a file changed since, ADR-0062 § 3's v1). */
export function peerInput(m: PeerMessage): PeerInput {
	const files = m.files.length === 0 ? "" : `\n\nFiles (local paths; read them if you need them):\n${m.files.map((f) => `- ${f.path} (${f.rev} when sent)`).join("\n")}`;
	const head = m.event === "completion" ? `The session "${m.fromTitle}" (${m.from}), which this session started, ended a turn:` : `Message from the session "${m.fromTitle}" (${m.from}):`;
	return { kind: "runtime", content: `${head}\n\n${m.text}${files}`, source: "system", via: { kind: "peer", event: m.event ?? "message", from: m.from, messageId: m.messageId, rootId: m.rootId } };
}

const admittedIds = (events: readonly Event[]): Set<string> => {
	const ids = new Set<string>();
	for (const e of events) if (e.type === "user_input" && e.via?.kind === "peer") ids.add(e.via.messageId);
	return ids;
};

export class PeerDelivery {
	readonly #o: PeerDeliveryOptions;
	readonly #inFlight = new Set<string>();
	#waking = false;
	#closed = false;

	constructor(options: PeerDeliveryOptions) {
		this.#o = options;
	}

	/** Read the inbox now: delete what the log holds, hand on what is new. Says what became of it: handed to the live run,
	 *  a wake started (or already starting), or waiting for the next run (the chain's budget is spent, or no wake here). */
	poke(): PeerOutcome {
		if (this.#closed) return "waiting";
		const run = this.#o.liveRun();
		const pending = this.#pending();
		if (run !== undefined) {
			for (const m of pending) this.#hand(run, m);
			return "handed";
		}
		if (this.#waking) return "woke";
		if (this.#o.onWake === undefined || pending.length === 0 || !(this.#o.mayWake?.(pending[0]!.rootId) ?? true)) return "waiting";
		const first = peerInput(pending[0]!);
		this.#waking = true;
		this.#inFlight.add(first.via.messageId);
		this.#o.onWake({ content: first.content as string, via: first.via });
		return "woke";
	}

	/** A run began: what is waiting rides its first admission. */
	takeForRun(run: Run): void {
		this.#waking = false;
		for (const m of this.#pending()) this.#hand(run, m);
	}

	/** The run settled: what it never admitted goes back to waiting, and a wake may follow. */
	onRunSettled(_run: Run): void {
		// the slot is free, so nothing is in flight: what the log holds is deleted at the next look, the rest waits again
		this.#inFlight.clear();
		this.#waking = false;
		setTimeout(() => this.poke(), 0); // never start a run from inside the settling one
	}

	close(): void {
		this.#closed = true;
	}

	#pending(): PeerMessage[] {
		const admitted = admittedIds(this.#o.events());
		const pending: PeerMessage[] = [];
		for (const m of readInbox(this.#o.root, this.#o.sessionId)) {
			if (admitted.has(m.messageId)) {
				this.#inFlight.delete(m.messageId);
				removeMessage(this.#o.root, this.#o.sessionId, m.messageId);
			} else if (!this.#inFlight.has(m.messageId) && m.held !== true) pending.push(m);
		}
		return pending;
	}

	#hand(run: Run, m: PeerMessage): void {
		if (run.deliver(peerInput(m))) this.#inFlight.add(m.messageId);
	}
}
