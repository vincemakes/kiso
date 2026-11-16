import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRuntimeInput, type Event } from "@vincemakes/kiso-core";

/**
 * ADR-0062 § 6–§ 7: the causal chain across sessions, its wake budget, and the completion notice a child owes its parent.
 * A person's line opens a chain; a run a message started carries that message's chain; a session's current chain is read
 * from its own log, never passed by a model. The budget is counted per chain in a small file per chain, so a restart never
 * refills a spent one.
 */

export const MAX_CHAIN_WAKES = 20;

/** The chain a session is on: the last admitted input that opened one (the person's) or carried one (a message). */
export function currentChain(events: readonly Event[], address: string): string {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i]!;
		if (e.type !== "user_input") continue;
		if (e.via?.kind === "peer") return e.via.rootId;
		if (!isRuntimeInput(e)) return `${address}#${e.seq}`;
	}
	return `${address}#0`;
}

/** Autonomous wakes per chain, durable: `take` spends one, false once `max` are spent. */
export class ChainBudget {
	readonly #dir: string;
	readonly #max: number;

	constructor(dir: string, max = MAX_CHAIN_WAKES) {
		this.#dir = dir;
		this.#max = max;
	}

	#path(rootId: string): string {
		return join(this.#dir, `${createHash("sha256").update(rootId).digest("hex").slice(0, 24)}.json`);
	}

	spent(rootId: string): number {
		try {
			const n = (JSON.parse(readFileSync(this.#path(rootId), "utf8")) as { wakes?: unknown }).wakes;
			return typeof n === "number" ? n : 0;
		} catch {
			return 0;
		}
	}

	take(rootId: string): boolean {
		const wakes = this.spent(rootId);
		if (wakes >= this.#max) return false;
		mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
		const path = this.#path(rootId);
		writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify({ rootId, wakes: wakes + 1, at: Date.now() }), { mode: 0o600 });
		renameSync(`${path}.${process.pid}.tmp`, path);
		return true;
	}
}

const RANK: Readonly<Record<string, number>> = { plan: 0, default: 1, "accept-edits": 2, "full-access": 3 };

/** ADR-0062 § 8: whether the receiver may reach further than the sender, so a message between them is held for the person: a
 *  wider permission mode, or a folder the sender was not given; a mode that cannot be ranked counts as further. Two sessions in
 *  full access are never held (owner, 2026-11-16): nothing is wider than full access, and folders do not bound it. */
export function reachesFurther(sender: { readonly tier: string; readonly added: readonly string[] }, receiver: { readonly tier: string; readonly added: readonly string[] }): boolean {
	if (sender.tier === "full-access" && receiver.tier === "full-access") return false;
	return (RANK[receiver.tier] ?? 9) > (RANK[sender.tier] ?? -1) || receiver.added.some((f) => !sender.added.includes(f));
}

export type CompletionState = "finished" | "failed" | "waiting on you" | "ended with tasks still running";

/** The notice a child owes its parent for the run that just ended, or null: owed for its first run, and for a run that
 *  admitted a message from the parent; never for runs the person drives alone. `events` are that run's, in order. */
export function completionNotice(input: {
	readonly run: readonly Event[];
	readonly firstRun: boolean;
	readonly parent: string;
	readonly tasksRunning: boolean;
	readonly waiting: boolean;
}): { readonly state: CompletionState; readonly excerpt: string } | null {
	const fromParent = input.run.some((e) => e.type === "user_input" && e.via?.kind === "peer" && e.via.event === "message" && e.via.from === input.parent);
	if (!input.firstRun && !fromParent) return null;
	const terminal = [...input.run].reverse().find((e) => e.type === "terminal");
	const last = input.run.map((e) => e.type).lastIndexOf("assistant_start");
	const reply = input.run.slice(Math.max(0, last)).flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
	const state: CompletionState = input.waiting ? "waiting on you" : terminal?.type === "terminal" && terminal.outcome.kind !== "completed" ? "failed" : input.tasksRunning ? "ended with tasks still running" : "finished";
	return { state, excerpt: reply.length > 400 ? `${reply.slice(0, 400)}…` : reply };
}
