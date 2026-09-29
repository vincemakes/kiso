/**
 * TUI2-R2 slice ① — the state projection: a session's durable log →
 * the card the picker and the listing both render.
 *
 * The card is a PURE PROJECTION and this file adds no facts. Every field
 * comes from a durable event the product already writes, read through the
 * runtime's OWN accessors:
 *
 *   openRunId(records)        — recovery's own "is a run still open?"
 *                               (the ▌ brick: no terminal event)
 *   executionLedger(events)   — the L2 ledger's own uncertain status
 *                               (started, no receipt — the crash window)
 *   pendingApprovals()        — the session's own live-ask accessor
 *                               (decided/expired/dead-run all excluded)
 *   the `terminal` event      — its outcome kind, read as written
 *
 * Nothing here re-implements any of them. That is the point: a badge is a
 * claim about what `kiso resume` will do, and the only way it can never
 * lie is for it to be derived from the same facts the resume derives
 * from. A second derivation — however careful — is a second source of
 * truth, and two sources of truth about durability is none.
 *
 * The projection is read-only by construction: it loads and it counts.
 * The R-I-p2 rule (a listing never writes) holds trivially — there is no
 * write call in this file, and the accessors it calls have none either.
 *
 * What a human READS about a card is presentation and lives in the
 * terminal layer (sessionNote — the KC3 §1 split); this file owns the
 * FACTS.
 */

import { executionLedger, openRunId, sessionTitle, type SessionListing, type StoreRecord } from "@vincemakes/kiso-runtime/internal";

/** The five durable states, in the order the projection resolves them. */
export type SessionBadge = "uncertain" | "ask" | "interrupted" | "completed" | "failed" | "unknown";

export interface SessionCard {
	readonly id: string;
	/** REL-0152-D6b: what the conversation was ABOUT. An id is unique and
	 *  says nothing; a picker of five ids is five rows the human cannot
	 *  tell apart. From the runtime's one definition — never a second
	 *  copy of the rule (the listing and the picker disagreed once). */
	readonly title: string;
	readonly badge: SessionBadge;
	/** The human's unit: one user_input is one turn. (SessionMeta.runs
	 *  counts runIds, which a resume increments without the human having
	 *  said anything — that is a different number and not the one a
	 *  picker row means.) */
	readonly turns: number | null;
	/** The last record's own stamp — the store's `updatedAt`, never a
	 *  file mtime (a copied home would lie about every age). */
	readonly updatedAt: number;
	/** The uncertain ledger's size — the ? badge's count. */
	readonly uncertain: number;
	/** The unanswered permission requests — the ◌ badge's count. */
	readonly asks: number;
	/** The terminal outcome's kind, when the run ended; null while it is
	 *  open. The ✗ note names it rather than inventing one word for six
	 *  different endings. */
	readonly outcome: string | null;
	/** 0.40.0: where the session started (its profile's `workspace`);
	 *  null when unknown. */
	readonly workspace: string | null;
	/** 0.40.0: the config profile its latest revision names. */
	readonly profileName: string | null;
	/** 0.40.0: in a project folder by the migration's inference, never by
	 *  a recorded workspace — the listing marks it. */
	readonly inferred?: boolean;
}

/**
 * The projection. `asks` arrives as DATA because its accessor lives on
 * the session object (pendingApprovals) rather than on the record list —
 * passing the count keeps this function pure and unit-testable over a
 * fixture the real writer produced.
 *
 * The precedence, and why it is this one:
 *
 *   1. uncertain — the spec's explicit override. An interrupted run that
 *      also holds an undecided side effect cannot resume until a human
 *      rules on it, so the badge must show the blocking condition, not
 *      the recoverable one.
 *   2. ask — an unanswered question is likewise the thing standing
 *      between the session and its own continuation.
 *   3. interrupted — no terminal event: the run was cut mid-flight.
 *   4/5. the terminal's own verdict.
 */
export function projectSessionCard(input: {
	readonly id: string;
	readonly updatedAt: number;
	readonly records: readonly StoreRecord[];
	readonly asks: number;
	readonly workspace?: string | null;
	readonly profileName?: string | null;
	/** Graphite R3d: the session's `/name`, which wins over the derived title */
	readonly name?: string | null;
}): SessionCard {
	const events = input.records.map((r) => r.event);
	// the ledger's own expression — the same one the recovery plan and the
	// session's uncertainExecutions() use, so the three can never disagree
	const uncertain = [...executionLedger(events).values()].filter((r) => r.status === "uncertain").length;
	const open = openRunId(input.records) !== undefined;
	// the LAST terminal is the session's verdict — an older run's ending
	// says nothing about where the session stands now
	let outcome: string | null = null;
	for (let i = events.length - 1; i >= 0; i -= 1) {
		const ev = events[i]!;
		if (ev.type === "terminal") {
			outcome = (ev as { outcome: { kind: string } }).outcome.kind;
			break;
		}
	}
	const turns = events.filter((e) => e.type === "user_input").length;
	const badge: SessionBadge =
		uncertain > 0
			? "uncertain"
			: input.asks > 0
				? "ask"
				: // a log with no terminal at all leaves openRunId undefined only
					// when it is empty; either way nothing durable says it ended
					open || outcome === null
					? "interrupted"
					: outcome === "completed"
						? "completed"
						: "failed";
	return {
		id: input.id,
		title: input.name ?? sessionTitle(input.records),
		badge,
		turns,
		updatedAt: input.updatedAt,
		uncertain,
		asks: input.asks,
		outcome,
		workspace: input.workspace ?? null,
		profileName: input.profileName ?? null,
	};
}

/** The shapes this module needs from the agent — structural, so the
 *  projection is testable without standing up a provider. */
interface CardSource {
	sessions(): readonly { readonly id: string; readonly updatedAt: number }[];
	session(options: { id: string }): Promise<{ pendingApprovals(): readonly unknown[] }>;
}

/**
 * The listing's cards, newest first — the order both the picker and
 * `kiso sessions` want (the thing you just left is the thing you are
 * most likely coming back for).
 *
 * The session object exists ONLY to read pendingApprovals(): opening one
 * loads its records and builds an event log, and writes nothing (no
 * lock, no file creation) — the read-only listing rule holds.
 */
export async function collectSessionCards(
	agent: CardSource,
	load: (id: string) => readonly StoreRecord[],
	profileOf: (id: string) => { readonly workspace: string | null; readonly profileName: string | null } = () => ({ workspace: null, profileName: null }),
): Promise<SessionCard[]> {
	const cards: SessionCard[] = [];
	for (const meta of [...agent.sessions()].sort((a, b) => b.updatedAt - a.updatedAt)) {
		// XP-1: the LISTING never enforces the profile contract — a session
		// whose recorded profile drifted (or whose sidecar is damaged) still
		// LISTS; the honest refusal happens at the open, where the message
		// can be acted on. acceptDrift is never passed here: it RECORDS an
		// acknowledgement, and a listing must write nothing.
		let asks = 0;
		try {
			const session = await agent.session({ id: meta.id });
			asks = session.pendingApprovals().length;
		} catch {
			// blocked by the profile contract — the card carries no ask badge
		}
		cards.push(projectSessionCard({ id: meta.id, updatedAt: meta.updatedAt, records: load(meta.id), asks, ...profileOf(meta.id) }));
	}
	return cards;
}

/**
 * The 0.40.0 dogfood (item 2) — a card from the SIDECAR alone: the summary
 * tenant the runtime writes at each run's start and end (or the one-time
 * migration wrote), plus the profile's workspace and name. No log is read.
 * A session with no summary says so ("no summary"); one whose log could not
 * be read when it was summarised says that ("log unreadable") — never a
 * guess, and never a read of the log to find out.
 */
export function cardFromListing(l: SessionListing & { readonly inferred?: boolean }): SessionCard {
	const s = l.summary;
	const base = { id: l.id, workspace: l.workspace, profileName: l.profileName, ...(l.inferred === true ? { inferred: true } : {}) };
	if (s === null) return { ...base, title: l.name ?? l.id, badge: "unknown", turns: null, updatedAt: l.mtime, uncertain: 0, asks: 0, outcome: "no summary" };
	const badge: SessionBadge =
		s.uncertain > 0 ? "uncertain" : s.asks > 0 ? "ask" : s.state === "open" ? "interrupted" : s.state === "completed" ? "completed" : s.state === null ? "unknown" : "failed";
	return {
		...base,
		title: l.name ?? s.title ?? l.id,
		badge,
		turns: s.turns,
		updatedAt: s.updatedAt,
		uncertain: s.uncertain,
		asks: s.asks,
		outcome: badge === "unknown" ? (s.turns === null ? "log unreadable" : "no run recorded") : s.state === "open" ? null : s.state,
	};
}

/** Every card from the sidecars, newest first (the order the picker and
 *  `kiso sessions` both want). */
export function cardsFromListings(listings: readonly (SessionListing & { readonly inferred?: boolean })[]): SessionCard[] {
	return listings.map(cardFromListing).sort((a, b) => b.updatedAt - a.updatedAt);
}
