/**
 * ADR-0063 M2 — session records (spec `spec-m2-session-records-2026-11-27`, rev 1.2).
 *
 * A record is a short, typed, append-only statement with its evidence. The
 * session log stores committed batches as `context_records` events; this
 * module owns everything core does not know: the vocabulary, the provenance
 * gate on user authority, the authority-aware reducer, the derived cursor,
 * the batch identity and the batch writer. Nothing here is on a run's path
 * yet, and M2 never projects records (M3 does).
 *
 * The active vocabulary is ADR-0063 § 5's four kinds. `change` and `fix` are
 * deferred vocabulary (the owner and GPT, 2026-11-27): E2's probe groups
 * decide whether they are ever added; until then they are unknown kinds.
 */
import type { Event, EventInput } from "@vincemakes/kiso-core";
import { locateQuote, type EvidenceOwner, type EvidenceRef, type Quote } from "./provenance.js";

export const RECORD_KINDS = ["constraint", "decision", "rejection", "correction"] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export type RecordAuthority = "user" | "external" | "model" | "tool";

/** The ADR-0063 § 5 envelope, with ADR-0064's EvidenceRef and Quote. */
export interface SessionRecord {
	readonly id: string;
	readonly kind: RecordKind;
	readonly text: string;
	readonly authority: RecordAuthority;
	readonly quote?: Quote;
	readonly evidence: readonly EvidenceRef[];
	readonly scope?: { readonly paths?: readonly string[]; readonly symbols?: readonly string[]; readonly subsystem?: string };
	readonly freshness: "durable" | "historical-observation" | "needs-revalidation";
	readonly observedAt?: number;
	readonly verifiedAt?: number;
	readonly validFrom?: number;
	readonly validUntil?: number;
	readonly supersedes?: readonly string[];
	readonly derivedFrom?: readonly string[];
}

/** What the extractor proposes; the runtime decides what commits. */
export type RecordCandidate = Omit<SessionRecord, "id" | "freshness"> & { readonly freshness?: SessionRecord["freshness"] };

export type Admission = { readonly record: SessionRecord; readonly dropped?: undefined } | { readonly record?: undefined; readonly dropped: string };

/**
 * Validate one candidate against the session's own log. A `user` claim
 * keeps the EXACT source bytes `locateQuote` returns. When the quote fails,
 * the record is DROPPED, whatever its kind: a downgrade to `model` would
 * keep its text's attribution ("the user decided …") with no evidence
 * behind it (GPT's M2a review, 2026-11-27; this reverses rev 1's
 * "a decision downgrades").
 * The extractor cannot assert `tool` or `external` authority: who asserted a
 * statement is evidence it cannot supply, so such a claim commits as `model`.
 */
export function admitRecord(events: readonly Event[], owner: EvidenceOwner, id: string, c: RecordCandidate): Admission {
	if (!(RECORD_KINDS as readonly string[]).includes(c.kind)) return { dropped: `unknown kind ${c.kind}` };
	if (c.text.trim() === "") return { dropped: "empty text" };
	const freshness = c.freshness ?? "durable";
	if (c.authority !== "user") return { record: { ...c, id, freshness, authority: "model" } };
	const located = c.quote !== undefined && c.quote.owner === owner ? locateQuote(events, c.quote) : null;
	if (located !== null) return { record: { ...c, id, freshness, quote: located } };
	return { dropped: "user quote failed the provenance check" };
}

const RANK: Record<RecordAuthority, number> = { user: 3, external: 2, model: 1, tool: 1 };

/**
 * ADR-0063 § 5.1: a lower authority never supersedes a higher one. The
 * matrix's "per kind" cells (model or tool superseding tool) are closed:
 * no active kind allows them.
 */
export function validSupersession(source: Pick<SessionRecord, "authority" | "kind">, target: Pick<SessionRecord, "authority" | "kind">): boolean {
	if (target.authority === "tool" && (source.authority === "model" || source.authority === "tool")) return false;
	return RANK[source.authority] >= RANK[target.authority];
}

export type IgnoredSupersession = { readonly source: string; readonly target: string; readonly why: string };

/** The active set: a pure function of the committed batches, in log order. */
export function reduceRecords(events: readonly Event[]): { readonly active: readonly SessionRecord[]; readonly ignored: readonly IgnoredSupersession[] } {
	const all: SessionRecord[] = [];
	const byId = new Map<string, SessionRecord>();
	const retired = new Set<string>();
	const ignored: IgnoredSupersession[] = [];
	for (const ev of events) {
		if (ev.type !== "context_records") continue;
		for (const r of ev.records as readonly SessionRecord[]) {
			for (const t of r.supersedes ?? []) {
				const target = byId.get(t);
				if (target === undefined) ignored.push({ source: r.id, target: t, why: "unknown target" });
				else if (!validSupersession(r, target)) ignored.push({ source: r.id, target: t, why: `${r.authority} cannot supersede ${target.authority}` });
				else retired.add(t);
			}
			all.push(r);
			byId.set(r.id, r);
		}
	}
	return { active: all.filter((r) => !retired.has(r.id)), ignored };
}

/** `sessionRecordCoverage`, derived: the furthest committed batch; −1 before any. */
export function recordCoverage(events: readonly Event[]): number {
	let to = -1;
	for (const ev of events) if (ev.type === "context_records" && ev.coversToSeq > to) to = ev.coversToSeq;
	return to;
}

/**
 * The M2 batch writer: the event to append for (from, to], or null when
 * the cursor already reached the target (no batch for an empty range).
 * M2 never writes `projection`; M3 is its first legal writer.
 */
export function recordsBatch(sessionId: string, coversFromSeq: number, coversToSeq: number, checkpoint: number | "none", records: readonly SessionRecord[]): (EventInput & { type: "context_records" }) | null {
	if (coversFromSeq >= coversToSeq) return null;
	return { type: "context_records", batchKey: batchKey(sessionId, coversFromSeq, coversToSeq, checkpoint), coversFromSeq, coversToSeq, records };
}

/** ADR-0063 § 5.3 batch identity: session, range and checkpoint (`summarized` seq, or "none"). */
export const batchKey = (sessionId: string, coversFromSeq: number, coversToSeq: number, checkpoint: number | "none"): string =>
	`${sessionId}:${coversFromSeq}:${coversToSeq}:${checkpoint}`;
