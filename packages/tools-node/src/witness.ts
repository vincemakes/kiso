/**
 * The committed revision witness (kiso-doc plan-revision-witness rev 1,
 * owner-approved 2026-10-08; amends WR-1 v2's "the model cites it back").
 *
 * The file tools may take the revision a mutation is based on from the
 * COMMITTED trajectory instead of the model's argument: the last
 * `[rev:…]` trailer a read_file / write_file / edit_file result showed
 * for the same file. What it reads is the projection the kernel hands the
 * binder (`ToolContext.committed`) — the messages the model sees — so a
 * voided draft's observation is absent by construction (the WR-1 v2
 * invariant its gate pins). It never reads the disk: a witness taken from
 * current bytes would make the stale guard compare the file with itself.
 *
 * A refused edit's result shows the current text and ends on its
 * revision; that is an observation like a read, and it counts.
 */
import type { Message, ToolContext } from "@vincemakes/kiso-core";

/** The tools whose results carry a revision trailer for their `path`. */
const WITNESS_TOOLS = new Set(["read_file", "write_file", "edit_file"]);
const REV_TRAILER = /\[rev:\s*([0-9a-f]{16})\]$/;

/** The last revision the messages show for the file `full` resolves to,
 *  or undefined. `resolve` maps a model-given path to the same key the
 *  tools resolve to (undefined for a path that escapes the workspace). */
export function revisionWitness(messages: readonly Message[], resolve: (path: string) => string | undefined, full: string): string | undefined {
	const paths = new Map<string, string>();
	let witness: string | undefined;
	for (const m of messages) {
		if (m.role === "assistant") {
			for (const b of m.blocks) if (b.type === "tool_use" && WITNESS_TOOLS.has(b.name) && typeof b.input.path === "string") paths.set(b.callId, b.input.path);
		} else if (m.role === "tool") {
			const path = paths.get(m.callId);
			if (path === undefined) continue;
			const text = typeof m.content === "string" ? m.content : m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			const hit = REV_TRAILER.exec(text.trimEnd());
			if (hit !== null && resolve(path) === full) witness = `rev:${hit[1]}`;
		}
	}
	return witness;
}

/** The file tools' `bindInput`: a revision the model gave is kept as is;
 *  an omitted one is bound from the committed trajectory when it shows one. */
export function bindRevision<I extends { path: string; expectedRevision?: string }>(input: I, ctx: ToolContext | undefined, resolve: (path: string) => string | undefined): I {
	if (input.expectedRevision !== undefined || ctx?.committed === undefined || typeof input.path !== "string") return input;
	const full = resolve(input.path);
	if (full === undefined) return input;
	const rev = revisionWitness(ctx.committed(), resolve, full);
	return rev === undefined ? input : { ...input, expectedRevision: rev };
}
