/**
 * E3 (0.2.1) — the rent ledger: every request's static model-side rent,
 * one line per surface.
 *
 * The static rent is the surface the model pays REGARDLESS of the turn's
 * content: the base system prompt, each extension's append, every tool's
 * serialized spec, and the per-request envelope. One line per surface,
 * four classes, measured in chars + the rounds' est-token convention
 * (chars/4, ceil — the E1 script's formula, the work order's own words,
 * R6):
 *
 *   - system:base       the session's own prompt as the CLI handed it
 *                       (built-in constant + project instructions — the
 *                       runtime cannot split those, R3). The runtime's
 *                       generated tool table is machinery BETWEEN base and
 *                       appends; it stays out of the ledger (counts live
 *                       in tool:<name> lines and the base's own line).
 *   - system:ext:<name> one line per extension with a non-empty
 *                       systemPrompt.append, measured on the append
 *                       string, in load order.
 *   - tool:<name>       one line per tool, measured on the exact
 *                       serialized ToolSpec projection the adapters
 *                       receive ({name, description, inputSchema} — the
 *                       registry.toSpecs() shape, protocol/messages.ts).
 *   - envelope          the per-request fixed overhead OUTSIDE the
 *                       conversation payloads: the R5 skeleton
 *                       JSON.stringify({model, messages: [], tools: []})
 *                       — a function of the model string only, never of
 *                       the payloads (the skeleton is the definition).
 *
 * R9: an absent surface is an absent line — an unconfigured mcp, a
 * session with no project instructions: no line. The absence IS the
 * ledger statement (the 0.1.45 diet-A precedent: not paid = no rent).
 *
 * Determinism (the reviewer-facing property): every line is derivable
 * from components the reviewer can recompute — the exported prompt
 * constant, the appends, the ToolSpec array, the request skeleton. The
 * ledger stores COUNTS, never payloads (the seqRange thin-pointer
 * discipline applied to rent).
 *
 * buildRentLedger is the SINGLE source: the R7 star gate drives a real
 * session with the script's predicted composition and asserts the
 * recorded ledger equals the prediction line for line.
 */

import type { ToolSpec } from "@vincemakes/kiso-core";

export interface RentLine {
	/** "system:base" | "system:ext:<name>" | "tool:<name>" | "envelope" */
	surface: string;
	/** length of the serialized surface, measured, never a copy */
	chars: number;
	/** Math.ceil(chars / 4) — the E1 script convention, pinned (R6) */
	estTokens: number;
}
/** The closed line set (the same gate discipline as the record fields). */
export const RENT_LINE_FIELDS = ["surface", "chars", "estTokens"] as const;

/** What the runtime knows about the static surface beyond what the
 *  adapter call itself carries: the base prompt as configured, and the
 *  per-extension appends in load order (the adapter's composed
 *  systemPrompt is the result — the parts are the ledger's inputs). */
export interface RentParts {
	base?: string;
	appends?: readonly { name: string; text: string }[];
}

export interface RentInput extends RentParts {
	model: string;
	tools?: readonly ToolSpec[];
}

const line = (surface: string, text: string): RentLine => ({
	surface,
	chars: text.length,
	estTokens: Math.ceil(text.length / 4),
});

/** The one ledger: system:base, then system:ext:* (load order), then
 *  tool:* (the array's order — the registry's toSpecs() order), then the
 *  envelope. Absent surfaces contribute no lines (R9). */
export function buildRentLedger(input: RentInput): RentLine[] {
	const lines: RentLine[] = [];
	if (input.base !== undefined) lines.push(line("system:base", input.base));
	for (const append of input.appends ?? []) lines.push(line(`system:ext:${append.name}`, append.text));
	for (const tool of input.tools ?? []) {
		lines.push(line(`tool:${tool.name}`, JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
	}
	// R5: the envelope is the request skeleton — a model-string function,
	// never the payloads; the empty arrays are literal (the definition).
	lines.push(line("envelope", JSON.stringify({ model: input.model, messages: [], tools: [] })));
	return lines;
}

/** The line validator — the same strict discipline as the record's other
 *  closed sets: no key outside the spec, every spec'd key present,
 *  non-empty surface (R9: a line exists only for a surface that exists),
 *  non-negative integer chars, and the estTokens cross-check (R6). The
 *  schema pins the LINE, not the multiset — duplicate surfaces are the
 *  writer's business, never a schema crash. */
export function validateRentLine(v: unknown): v is RentLine {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	const keys = Object.keys(o);
	const fields = RENT_LINE_FIELDS as readonly string[];
	if (keys.some((k) => !fields.includes(k))) return false;
	if (!fields.every((k) => k in o)) return false;
	if (typeof o.surface !== "string" || o.surface.length === 0) return false;
	const chars = o.chars;
	const estTokens = o.estTokens;
	if (typeof chars !== "number" || !Number.isInteger(chars) || chars < 0) return false;
	if (typeof estTokens !== "number" || !Number.isInteger(estTokens) || estTokens < 0) return false;
	if (estTokens !== Math.ceil(chars / 4)) return false;
	return true;
}
