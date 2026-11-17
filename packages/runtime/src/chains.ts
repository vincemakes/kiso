import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRuntimeInput, type Event } from "@vincemakes/kiso-core";
import type { PeerMessage } from "./inbox.js";

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

/** ADR-0062 § 7: the completion message a child (`from`) writes to its parent's inbox for the run `runId` that just settled,
 *  or null when none is owed. One per run: its id is the child, the run and "completion", so however many of the parent's
 *  messages the run admitted, and however often the settle is reported, the parent's inbox holds one. */
export function completionMessage(input: {
	readonly records: readonly { readonly runId: string; readonly event: Event }[];
	readonly runId: string;
	readonly from: string;
	readonly fromTitle: string;
	readonly parent: string;
	readonly tasksRunning: boolean;
}): PeerMessage | null {
	const run = input.records.filter((r) => r.runId === input.runId).map((r) => r.event);
	const notice = completionNotice({ run, firstRun: input.records[0]?.runId === input.runId, parent: input.parent, tasksRunning: input.tasksRunning, waiting: false });
	if (notice === null) return null;
	const messageId = createHash("sha256").update(`${input.from}\n${input.runId}\ncompletion`).digest("hex").slice(0, 24);
	return { messageId, from: input.from, fromTitle: input.fromTitle, text: `${notice.state}.${notice.excerpt === "" ? "" : `\n\n${notice.excerpt}`}`, files: [], rootId: currentChain(run, input.from), at: Date.now(), event: "completion" };
}

/**
 * ADR-0062 § 9: who started the run now going, read from the log: the first input after the last terminal. The person's own
 * line, another session's message, or anything else (a task notice, a completion notice, a wake).
 */
export function runStarter(events: readonly Event[]): "person" | "message" | "other" {
	let i = events.length - 1;
	while (i >= 0 && events[i]!.type !== "terminal") i--;
	const first = events.slice(i + 1).find((e) => e.type === "user_input");
	if (first === undefined || first.type !== "user_input") return "other";
	if (first.via?.kind === "peer") return first.via.event === "message" ? "message" : "other";
	return isRuntimeInput(first) ? "other" : "person";
}

/**
 * ADR-0062 § 9 (owner, 2026-11-16): the initiation a `start_session` call stands on. `asked` and `named` stand only on a run
 * the person's own line started; any other run turns them into `proposed`; a run another session's message started is
 * refused (null).
 */
export function startInitiation(events: readonly Event[], asked: "asked" | "named" | "proposed"): "asked" | "named" | "proposed" | null {
	const starter = runStarter(events);
	return starter === "message" ? null : starter === "person" ? asked : "proposed";
}
