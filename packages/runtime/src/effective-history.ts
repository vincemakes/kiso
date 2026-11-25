/**
 * ADR-0063 M0 — effective history: the log read as normalized evidence, the
 * one reading retrieval (M0.5), record extraction (M2), recall (M1) and the
 * later constraint matcher (M5) share.
 *
 * NO SECOND INTERPRETER. Every structural decision — which replacement is
 * final, which checkpoint is live, which draft was voided — comes from the
 * core's `resolveHistory`, the same function `projectMessages` calls. This
 * module only shapes evidence on top of it, and its pairing rule mirrors the
 * projection's pair atomicity (spec rev 2.2 § 3.3), in two views:
 *
 * - current: the event projects. A current result pairs only with a current
 *   declaration, exactly as `projectMessages` decides.
 * - covered: the event is inside the live checkpoint. A covered result pairs
 *   with a covered declaration; both stay as historical evidence with
 *   `coveredBy` — they are what recall exists to return.
 * - gone: voided model output. A result whose declaration is gone or absent
 *   is orphaned, always.
 *
 * The view is derived ONCE per event (`viewOf`) and every rule below reads
 * it; no branch re-tests `status` values on its own.
 *
 * Internal to the runtime in M0: not exported from the package index.
 */
import {
	SUMMARY_FRAMING,
	isRuntimeInput,
	projectMessages,
	resolveHistory,
	type ContentBlock,
	type Event,
	type HistoryResolution,
	type MessageSource,
	type UserInputVia,
} from "@vincemakes/kiso-core";

export type EvidenceView = "current" | "covered" | "gone";

export type EffectiveEvidence = {
	/** The event that carries the content (a text block: its first event). */
	readonly seq: number;
	readonly kind: "user" | "assistant" | "tool" | "permission" | "runtime";
	/** What the model saw (a replaced input: the final replacement). */
	readonly content: string;
	readonly authority: "user" | "model" | "tool" | "runtime" | "peer" | "unknown";
	readonly structuralStatus: "effective" | "replaced" | "vetoed" | "abandoned" | "orphaned";
	readonly provenance: {
		readonly via?: UserInputVia;
		readonly source?: MessageSource;
		readonly callId?: string;
		readonly coveredBy?: number;
	};
};

export type HumanAuthority = "user" | "runtime" | "peer" | "none";

/** Text only; an image renders as a stable placeholder and is never quotable. */
function contentText(content: string | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content.map((b) => (b.type === "text" ? b.text : "[image]")).join("");
}

/** Text blocks only, for the human-authored surface: images contribute nothing. */
function authoredText(content: string | readonly ContentBlock[]): string {
	if (typeof content === "string") return content;
	return content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
}

function seqOf(ev: Event): number {
	return (ev as { seq?: number }).seq ?? -1;
}

/**
 * Does this event carry a person's authority at all? (spec § 3.4, first
 * table). Not sufficient to commit a user-authority record: commitment still
 * requires the ADR-0063 verbatim check against `humanAuthoredSurface`.
 */
export function humanAuthority(ev: Event): HumanAuthority {
	if (ev.type === "user_input") {
		if (ev.via?.kind === "tasks") return "runtime";
		if (ev.via?.kind === "peer") return "peer";
		if (ev.source !== undefined && ev.source !== "user") return "none";
		return "user";
	}
	if (ev.type === "permission_decided") return ev.decidedBy === undefined ? "user" : "runtime";
	return "none";
}

/**
 * The exact text the person wrote — the only text a user-authority record
 * may quote (spec § 3.4, second table). A hook-rewritten input still
 * surfaces the ORIGINAL typed text (the rewrite is the host's, not the
 * person's); a vetoed input surfaces nothing; a skill surfaces its literal
 * invocation line, never the expanded body.
 */
export function humanAuthoredSurface(ev: Event, r: HistoryResolution): string | null {
	if (ev.type === "user_input") {
		if (humanAuthority(ev) !== "user") return null;
		if (r.replaced.get(ev.seq)?.content === null) return null;
		if (ev.via?.kind === "skill") return ev.via.line;
		return authoredText(ev.content);
	}
	if (ev.type === "permission_decided") {
		return ev.decidedBy === undefined && ev.reason !== undefined ? ev.reason : null;
	}
	return null;
}

function toEvidenceAuthority(a: HumanAuthority): EffectiveEvidence["authority"] {
	return a === "none" ? "unknown" : a;
}

/** Events at which the projection closes an open text block (pushText). */
const CLOSES_TEXT = new Set([
	"text_start",
	"text_end",
	"tool_call_end",
	"stop",
	"user_input",
	"assistant_start",
	"assistant_end",
	"microcompacted",
	"compacted",
]);

/**
 * The log as evidence, in log order. `audit` also returns the original text
 * of each replaced input as a `"replaced"` evidence.
 */
export function effectiveHistory(events: readonly Event[], opts: { readonly audit?: boolean } = {}): EffectiveEvidence[] {
	const r = resolveHistory(events);
	const viewOf = (ev: Event): EvidenceView => {
		const s = r.status(ev);
		return s === "effective" ? "current" : s === "covered" ? "covered" : "gone";
	};
	const coveredBy = r.summary?.eventSeq;
	const where = (view: EvidenceView): { coveredBy?: number } =>
		view === "covered" && coveredBy !== undefined ? { coveredBy } : {};
	const out: EffectiveEvidence[] = [];

	// One open text block per view: the projection segments the CURRENT
	// view's text; covered and gone text are segmented the same way among
	// their own events.
	const open = new Map<EvidenceView, { seq: number; text: string; source?: MessageSource }>();
	const closeText = (view: EvidenceView): void => {
		const block = open.get(view);
		if (block === undefined) return;
		open.delete(view);
		out.push({
			seq: block.seq,
			kind: "assistant",
			content: block.text,
			authority: "model",
			structuralStatus: view === "gone" ? "abandoned" : "effective",
			provenance: { ...(block.source !== undefined ? { source: block.source } : {}), ...where(view) },
		});
	};
	// The declarations seen so far, by seq and by callId, with their view.
	const declBySeq = new Map<number, EvidenceView>();
	const declViewsByCallId = new Map<string, Set<EvidenceView>>();
	let pendingSource = new Map<EvidenceView, MessageSource>();

	for (const ev of events) {
		const view = viewOf(ev);
		const seq = seqOf(ev);
		if (CLOSES_TEXT.has(ev.type)) closeText(view);
		switch (ev.type) {
			case "user_input": {
				const replacement = r.replaced.get(ev.seq);
				const runtime = isRuntimeInput(ev);
				const base = {
					seq,
					kind: runtime ? ("runtime" as const) : ("user" as const),
					authority: toEvidenceAuthority(humanAuthority(ev)),
				};
				const provenance = {
					...(ev.via !== undefined ? { via: ev.via } : {}),
					...(ev.source !== undefined ? { source: ev.source } : {}),
					...where(view),
				};
				if (replacement !== undefined && opts.audit === true) {
					out.push({ ...base, content: contentText(ev.content), structuralStatus: "replaced", provenance });
				}
				if (replacement !== undefined && replacement.content === null) {
					out.push({ ...base, content: "", structuralStatus: "vetoed", provenance });
				} else {
					const content = replacement?.content ?? ev.content;
					out.push({ ...base, content: contentText(content as string | readonly ContentBlock[]), structuralStatus: "effective", provenance });
				}
				break;
			}
			case "text_start":
			case "tool_call_start":
			case "assistant_start":
				if (ev.source !== undefined) pendingSource.set(view, ev.source);
				break;
			case "text_delta": {
				const block = open.get(view);
				if (block === undefined) {
					const source = pendingSource.get(view);
					open.set(view, { seq, text: ev.text, ...(source !== undefined ? { source } : {}) });
				} else block.text += ev.text;
				break;
			}
			case "tool_call_end": {
				declBySeq.set(seq, view);
				const views = declViewsByCallId.get(ev.callId) ?? new Set<EvidenceView>();
				views.add(view);
				declViewsByCallId.set(ev.callId, views);
				out.push({
					seq,
					kind: "assistant",
					content: `${ev.name} ${JSON.stringify(ev.input ?? {})}`,
					authority: "model",
					structuralStatus: view === "gone" ? "abandoned" : "effective",
					provenance: { callId: ev.callId, ...where(view) },
				});
				break;
			}
			case "tool_result": {
				// Pairing (spec § 3.3): a result with invocationSeq names its
				// declaration; without it, the projection's legacy rule — any
				// earlier declaration with its callId — applied within the
				// result's own view. A gone declaration never pairs.
				const paired =
					ev.invocationSeq !== undefined
						? declBySeq.get(ev.invocationSeq) === view
						: declViewsByCallId.get(ev.callId)?.has(view) === true;
				out.push({
					seq,
					kind: "tool",
					content: contentText(ev.content),
					authority: "tool",
					structuralStatus: paired && view !== "gone" ? "effective" : "orphaned",
					provenance: {
						callId: ev.callId,
						...(ev.source !== undefined ? { source: ev.source } : {}),
						...where(view),
					},
				});
				break;
			}
			case "permission_decided":
				out.push({
					seq,
					kind: "permission",
					content: ev.reason !== undefined ? `${ev.decision}: ${ev.reason}` : ev.decision,
					authority: toEvidenceAuthority(humanAuthority(ev)),
					structuralStatus: "effective",
					provenance: { ...(ev.callId !== undefined ? { callId: ev.callId } : {}), ...where(view) },
				});
				break;
			case "stop":
			case "assistant_end":
				pendingSource = new Map();
				break;
		}
	}
	for (const view of ["current", "covered", "gone"] as const) closeText(view);
	out.sort((a, b) => a.seq - b.seq);
	return out;
}

/**
 * The parity check (spec § 4, test 1 and the real-log script): the CURRENT
 * view of effective history must say what `projectMessages` renders, role by
 * role — user inputs, assistant text blocks, tool results — each in its own
 * order (the projection may hold a mid-execution input past its results, so
 * the roles are compared as separate sequences). Tool-result content is
 * compared only when the log holds no compaction clearings (the projection
 * renders placeholders there; evidence keeps the truth). Returns the
 * mismatches; an empty list is parity.
 */
export function parityMismatches(events: readonly Event[]): string[] {
	const evidence = effectiveHistory(events).filter((e) => e.structuralStatus === "effective" && e.provenance.coveredBy === undefined);
	const messages = projectMessages(events);
	const cleared = events.some((e) => e.type === "compacted" || e.type === "microcompacted");
	const pairs: [string, string[], string[]][] = [
		[
			"user",
			messages.flatMap((m) => (m.role === "user" && !(typeof m.content === "string" && m.content.startsWith(SUMMARY_FRAMING)) ? [contentText(m.content)] : [])),
			evidence.filter((e) => e.kind === "user" || e.kind === "runtime").map((e) => e.content),
		],
		[
			"assistant text",
			messages.flatMap((m) => (m.role === "assistant" ? m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])) : [])),
			evidence.filter((e) => e.kind === "assistant" && e.provenance.callId === undefined).map((e) => e.content),
		],
		[
			"tool result",
			messages.flatMap((m) => (m.role === "tool" ? [cleared ? m.callId : `${m.callId}\u0000${contentText(m.content)}`] : [])),
			evidence.filter((e) => e.kind === "tool").map((e) => (cleared ? e.provenance.callId ?? "" : `${e.provenance.callId ?? ""}\u0000${e.content}`)),
		],
	];
	const out: string[] = [];
	for (const [role, projected, evidenced] of pairs) {
		if (projected.length !== evidenced.length) out.push(`${role}: projection ${projected.length}, evidence ${evidenced.length}`);
		else if (projected.some((p, i) => p !== evidenced[i])) out.push(`${role}: content differs at ${projected.findIndex((p, i) => p !== evidenced[i])}`);
	}
	return out;
}
