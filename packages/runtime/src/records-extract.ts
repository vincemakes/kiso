/**
 * ADR-0063 M2b — one extraction over a range (cursor, target]: the
 * serializer, the instruction, parsing, one retry on a deterministic
 * failure, and batch admission (spec `spec-m2b-extraction-wiring-2026-11-27`).
 *
 * The model call is injected (`query`), so this module is pure apart from
 * it. The session owns timing, accounting and the single writer.
 */
import type { Event } from "@vincemakes/kiso-core";
import { findSecret } from "@vincemakes/kiso-secrets";
import { effectiveHistory } from "./effective-history.js";
import type { EvidenceOwner, EvidenceRef } from "./provenance.js";
import { admitRecord, RECORD_KINDS, reduceRecords, type RecordAuthority, type RecordCandidate, type SessionRecord } from "./session-records.js";

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);

/**
 * The range's evidence, one `#seq [who] text` line each: the person's own
 * input in full; a suggestion chip and runtime input labelled as not the
 * person's words; assistant text, tool calls and tool results bounded.
 * Thinking, abandoned output, orphans and runtime evidence (program-written
 * blocks: K3) are omitted.
 */
export function serializeRange(events: readonly Event[], from: number, to: number): string {
	const bySeq = new Map(events.map((e) => [e.seq, e]));
	const lines: string[] = [];
	for (const e of effectiveHistory(events)) {
		if (e.seq <= from || e.seq > to || e.structuralStatus !== "effective") continue;
		const ev = bySeq.get(e.seq);
		if (ev?.type === "user_input") {
			// the person's own input, a suggestion chip, or runtime input (tasks, peer)
			const who = ev.source === "suggestion" ? "suggestion chip — not the person's words" : e.authority === "user" ? "person" : "runtime input — not the person's words";
			lines.push(`#${e.seq} [${who}] ${e.content}`);
		} else if (ev?.type === "tool_call_end") lines.push(`#${e.seq} [tool call ${ev.name}] ${cut(JSON.stringify(ev.input ?? null), 400)}`);
		else if (e.kind === "tool") lines.push(`#${e.seq} [${`tool result ${e.provenance.tool ?? ""}`.trimEnd()}] ${cut(e.content, 300)}`);
		else if (e.kind === "permission") lines.push(`#${e.seq} [permission] ${e.content}`);
		else if (e.kind === "assistant") lines.push(`#${e.seq} [assistant] ${cut(e.content, 1500)}`);
	}
	return lines.join("\n");
}

export const EXTRACTOR_SYSTEM = `You extract SESSION RECORDS from a coding session's evidence: short typed statements that must not be forgotten.

Kinds:
- constraint: a rule the person set (what must or must not be done).
- decision: a choice that was made, WITH its reason.
- rejection: an approach that was tried or considered and dropped, WITH the reason it was dropped.
- correction: the person corrected or revoked something said earlier.

Reply with ONLY a JSON array, no prose, no code fence. Each item:
{"kind": one of the kinds, "text": one or two sentences, "authority": "user" | "model", "quote": the person's exact words (only when authority is "user"), "evidence": [the #numbers of the evidence lines it rests on; the person's line first for a user record], "supersedes": [ids of active records this replaces]}
Authority "user" ONLY when the person typed it themselves; copy their exact words into "quote". Text that came from a tool result, a file, a runtime notice or a suggestion chip is never the person's.
For a "model" record, state the content neutrally ("decided: X because Y"); never attribute it to the person.
At most 25 records per answer: keep the ones that must not be forgotten. An empty array [] is a valid answer.`;

/** The user message: the active records (so `supersedes` can name them) and the evidence. */
export function extractionPrompt(active: readonly SessionRecord[], serialized: string): string {
	const records = active.length ? `Active records (id: kind, text):\n${active.map((r) => `${r.id}: ${r.kind}, ${r.text}`).join("\n")}` : "Active records: none.";
	return `${records}\n\nEvidence (#seq [who] text):\n${serialized}`;
}

export const RETRY_ASK = "That answer was cut off or was not a JSON array. Reply again with at most 12 records, as ONLY a JSON array.";

/** The model's JSON array, or null when the answer is not one. */
export function parseCandidates(text: string): unknown[] | null {
	const s = text.indexOf("[");
	const e = text.lastIndexOf("]");
	if (s < 0 || e < s) return null;
	try {
		const v: unknown = JSON.parse(text.slice(s, e + 1));
		return Array.isArray(v) ? v : null;
	} catch {
		return null;
	}
}

export type DropCounts = Readonly<Record<string, number>>;

/**
 * Admit one batch, in the spec's order: kind, empty text, authority (tool and
 * external become model), the evidence range (every ref is this session's,
 * inside (from, to]), provenance, then secrets. Ids are `<from>:<to>#<i>`.
 */
export function admitBatch(events: readonly Event[], owner: EvidenceOwner, from: number, to: number, raw: readonly unknown[]): { readonly records: readonly SessionRecord[]; readonly drops: DropCounts } {
	const records: SessionRecord[] = [];
	const drops: Record<string, number> = {};
	const drop = (why: string): void => {
		drops[why] = (drops[why] ?? 0) + 1;
	};
	raw.forEach((item, i) => {
		if (typeof item !== "object" || item === null) return drop("not an object");
		const c = item as Record<string, unknown>;
		const seqs = Array.isArray(c.evidence) ? c.evidence.filter((x): x is number => Number.isSafeInteger(x)) : [];
		if (seqs.length === 0 || seqs.some((s) => s <= from || s > to)) return drop("evidence outside the range");
		const evidence: EvidenceRef[] = seqs.map((seq) => ({ owner, seq }));
		const authority: RecordAuthority = c.authority === "user" ? "user" : "model";
		const candidate: RecordCandidate = {
			kind: (RECORD_KINDS as readonly string[]).includes(String(c.kind)) ? (c.kind as RecordCandidate["kind"]) : (String(c.kind) as never),
			text: typeof c.text === "string" ? c.text : "",
			authority,
			evidence,
			...(authority === "user" && typeof c.quote === "string" ? { quote: { owner, seq: seqs[0]!, span: c.quote } } : {}),
			...(Array.isArray(c.supersedes) ? { supersedes: c.supersedes.map(String) } : {}),
		};
		const a = admitRecord(events, owner, `${from}:${to}#${i}`, candidate);
		if (a.record === undefined) return drop(a.dropped);
		const secret = findSecret(a.record.text) ?? (a.record.quote !== undefined ? findSecret(a.record.quote.span) : null);
		if (secret !== null) return drop(`contains a secret: ${secret.kind}`);
		records.push(a.record);
	});
	return { records, drops };
}

export interface QueryResult {
	readonly text: string;
	readonly truncated: boolean;
}

export type ExtractionOutcome =
	| { readonly kind: "batch"; readonly from: number; readonly to: number; readonly records: readonly SessionRecord[]; readonly drops: DropCounts; readonly retried: boolean; readonly emptyAfterFailure: boolean }
	| { readonly kind: "transport"; readonly from: number; readonly to: number; readonly error: string };

/**
 * One extraction. A transport failure (the query throws: non-200, a timeout,
 * an abort) writes nothing, so its range merges into the next boundary. A
 * deterministic failure (unparseable, or truncated) earns ONE retry; if that
 * fails too, the range commits empty, and a range that cannot parse twice is
 * not paid for forever (B2).
 */
export async function extractRange(args: {
	readonly events: readonly Event[];
	readonly owner: EvidenceOwner;
	readonly from: number;
	readonly to: number;
	readonly query: (messages: readonly { readonly role: "user" | "assistant"; readonly text: string }[]) => Promise<QueryResult>;
}): Promise<ExtractionOutcome> {
	const { events, owner, from, to } = args;
	const prompt = extractionPrompt(reduceRecords(events).active, serializeRange(events, from, to));
	let first: QueryResult;
	try {
		first = await args.query([{ role: "user", text: prompt }]);
	} catch (err) {
		return { kind: "transport", from, to, error: err instanceof Error ? err.message : String(err) };
	}
	let raw = first.truncated ? null : parseCandidates(first.text);
	let retried = false;
	if (raw === null) {
		retried = true;
		let second: QueryResult;
		try {
			second = await args.query([{ role: "user", text: prompt }, { role: "assistant", text: first.text.slice(0, 2000) }, { role: "user", text: RETRY_ASK }]);
		} catch (err) {
			return { kind: "transport", from, to, error: err instanceof Error ? err.message : String(err) };
		}
		raw = second.truncated ? null : parseCandidates(second.text);
		if (raw === null) return { kind: "batch", from, to, records: [], drops: {}, retried, emptyAfterFailure: true };
	}
	const { records, drops } = admitBatch(events, owner, from, to, raw);
	return { kind: "batch", from, to, records, drops, retried, emptyAfterFailure: false };
}
