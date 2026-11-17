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
 * The wake budget across sessions is ADR-0062 § 6's (PR 3); until then a message to an idle session always wakes it.
 */

export interface PeerDeliveryOptions {
	readonly root: string;
	readonly sessionId: string;
	readonly events: () => readonly Event[];
	readonly liveRun: () => Run | undefined;
	/** Start ONE run whose first input is this message. Absent: messages wait for the next run. */
	readonly onWake?: (input: { readonly content: string; readonly via: UserInputVia }) => void;
}

/** What the model reads: who sent it, the text, and the files as paths (the receiver reads them with its own tools). */
export function peerInput(m: PeerMessage): PeerInput {
	const files = m.files.length === 0 ? "" : `\n\nFiles (local paths; read them if you need them):\n${m.files.map((f) => `- ${f.path}`).join("\n")}`;
	const content = `Message from the session "${m.fromTitle}" (${m.from}):\n\n${m.text}${files}`;
	return { kind: "runtime", content, source: "system", via: { kind: "peer", event: "message", from: m.from, messageId: m.messageId, rootId: m.rootId } };
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

	/** Read the inbox now: delete what the log holds, hand on what is new. */
	poke(): void {
		if (this.#closed) return;
		const run = this.#o.liveRun();
		const pending = this.#pending();
		if (run !== undefined) for (const m of pending) this.#hand(run, m);
		else if (!this.#waking && this.#o.onWake !== undefined && pending.length > 0) {
			const first = peerInput(pending[0]!);
			this.#waking = true;
			this.#inFlight.add(first.via.messageId);
			this.#o.onWake({ content: first.content as string, via: first.via });
		}
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
			} else if (!this.#inFlight.has(m.messageId)) pending.push(m);
		}
		return pending;
	}

	#hand(run: Run, m: PeerMessage): void {
		if (run.deliver(peerInput(m))) this.#inFlight.add(m.messageId);
	}
}
