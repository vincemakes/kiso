/**
 * ADR-0064 A2 — the context compiler (actor RFC § 6.2): it orders, budgets and
 * renders context sources into the bytes of a lease session's bootstrap.
 *
 * Deterministic: the same inputs give the same bytes (no clock, no randomness).
 * A source without a renderer is an error, never a silent skip. An over-budget
 * source is cut at a line boundary with a fixed marker and named in `truncated`;
 * nothing is summarized by a model call.
 *
 * Invariant 3 (A2 spec § 4.4): the bytes open by naming the WorkRevision they
 * snapshot, and say that fresher evidence wins; they never claim to be current.
 */
import { createHash } from "node:crypto";
import type { Commitment } from "./reducer.js";

export type ContextSource =
	| { readonly kind: "work-state" }
	| { readonly kind: "handoff" }
	| { readonly kind: "recent-evidence" }
	| { readonly kind: "consumer"; readonly name: string }
	| { readonly kind: "actor-identity" }
	| { readonly kind: "project-instructions" }
	| { readonly kind: "work-records" }
	| { readonly kind: "actor-memory" }
	| { readonly kind: "project-memory" };

export type SourceRenderer = (input: { readonly commitment: Commitment; readonly budget: number }) => { readonly text: string; readonly revision: string };

export type CompiledContext = {
	readonly projection: string;
	readonly sourceRevisions: Readonly<Record<string, string>>;
	readonly digest: string;
	readonly truncated: readonly string[];
};

export const DEFAULT_SOURCE_BUDGET = 8 * 1024;
export const TRUNCATED_MARKER = "[… cut at this source's budget]";
const RECENT_EVIDENCE_CEILING = 10;

const sourceName = (s: ContextSource): string => (s.kind === "consumer" ? `consumer:${s.name}` : s.kind);

/** The fixed first line: the snapshot's revision, and its place below fresher evidence. */
export const snapshotHead = (revision: number): string =>
	`Work snapshot at revision ${revision}, taken when this session started. It is not the current state: newer events in this conversation take precedence over it, and it never overrides what the person says here.`;

function workState({ commitment: c }: { readonly commitment: Commitment }): { text: string; revision: string } {
	const lines = [`Objective: ${c.objective}`, `Status at revision ${c.revision}: ${c.status}`];
	for (const authority of ["user", "system", "agent"] as const) {
		const criteria = c.acceptance.filter((a) => a.authority === authority);
		if (criteria.length === 0) continue;
		const done = c.completion[authority];
		lines.push(`Acceptance set by ${authority === "user" ? "the person" : authority === "system" ? "the host" : "the agent"} (${done.met}/${done.required} required met):`);
		for (const a of criteria) {
			const met = c.evidence.some((e) => e.criterionIds.includes(a.criterionId));
			lines.push(`- [${met ? "evidenced" : "open"}${a.required ? "" : ", optional"}] ${a.text}${a.quote !== undefined ? ` (the person's words: "${a.quote.span}")` : ""}`);
		}
	}
	const open = c.effects.filter((e) => e.status === "prepared" || e.status === "uncertain");
	if (open.length > 0) {
		lines.push("Effects not settled at this revision:");
		for (const e of open) lines.push(`- ${e.label}: ${e.status}${e.status === "uncertain" ? " (dispatched, outcome unknown: never retry it without a person's ruling)" : ""}`);
	}
	return { text: lines.join("\n"), revision: String(c.revision) };
}

function handoff({ commitment: c }: { readonly commitment: Commitment }): { text: string; revision: string } {
	return { text: c.lastHandoff === undefined ? "No earlier session left a note." : `The previous session's own note:\n${c.lastHandoff}`, revision: String(c.revision) };
}

function recentEvidence({ commitment: c, budget }: { readonly commitment: Commitment; readonly budget: number }): { text: string; revision: string } {
	const lines: string[] = [];
	let bytes = 0;
	for (const e of [...c.evidence].reverse().slice(0, RECENT_EVIDENCE_CEILING)) {
		const ref = "log" in e.ref ? `${e.ref.log.owner}#${e.ref.log.seq}` : "effect" in e.ref ? `effect ${e.ref.effect.effectId}` : `${e.ref.external.source} at ${e.ref.external.observedAt}`;
		const line = `- ${ref} for ${e.criterionIds.join(", ")}`;
		if (bytes + Buffer.byteLength(line) + 1 > budget) break;
		lines.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}
	return { text: lines.length === 0 ? "No evidence recorded yet." : lines.join("\n"), revision: String(c.revision) };
}

export const BUILTIN_RENDERERS: Readonly<Record<string, SourceRenderer>> = { "work-state": workState, handoff, "recent-evidence": recentEvidence };

const HEADINGS: Readonly<Record<string, string>> = { "work-state": "Work state", handoff: "Handoff", "recent-evidence": "Recent evidence" };

function cut(text: string, budget: number): { text: string; cut: boolean } {
	if (Buffer.byteLength(text) <= budget) return { text, cut: false };
	const kept: string[] = [];
	let bytes = Buffer.byteLength(TRUNCATED_MARKER) + 1;
	for (const line of text.split("\n")) {
		if (bytes + Buffer.byteLength(line) + 1 > budget) break;
		kept.push(line);
		bytes += Buffer.byteLength(line) + 1;
	}
	return { text: [...kept, TRUNCATED_MARKER].join("\n"), cut: true };
}

export function compileContext(input: {
	readonly commitment: Commitment;
	readonly sources: readonly ContextSource[];
	readonly budgets?: Readonly<Record<string, number>>;
	readonly renderers?: Readonly<Record<string, SourceRenderer>>;
}): CompiledContext {
	const renderers = { ...BUILTIN_RENDERERS, ...input.renderers };
	const parts = [snapshotHead(input.commitment.revision)];
	const sourceRevisions: Record<string, string> = { work: String(input.commitment.revision) };
	const truncated: string[] = [];
	for (const source of input.sources) {
		const name = sourceName(source);
		const render = renderers[name];
		if (render === undefined) throw new Error(`no renderer for context source ${name}`);
		const budget = input.budgets?.[name] ?? DEFAULT_SOURCE_BUDGET;
		const out = render({ commitment: input.commitment, budget });
		const body = cut(out.text, budget);
		if (body.cut) truncated.push(name);
		parts.push(`## ${HEADINGS[name] ?? name}\n${body.text}`);
		sourceRevisions[name] = out.revision;
	}
	const projection = parts.join("\n\n");
	return { projection, sourceRevisions, digest: createHash("sha256").update(projection).digest("hex"), truncated };
}
