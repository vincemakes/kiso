/**
 * E3 — the request-surface script's declaration (consumed by the runtime
 * test suite, which drives the default composition exactly as the CLI
 * builds it — the R7 star gate). The script itself stays plain .mjs:
 * this sidecar only lets tsc typecheck the import.
 */

export interface RentParts {
	base?: string;
	appends?: readonly { name: string; text: string }[];
}

export interface RentLine {
	surface: string;
	chars: number;
	estTokens: number;
}

export interface CompositionParts {
	base: string;
	tools: readonly import("@vincemakes/kiso-core").Tool<any>[];
	extensions: readonly { name: string; systemPrompt?: { append: string } }[];
}

export function defaultCompositionParts(options?: { home?: string }): Promise<CompositionParts>;

export function predictDefaultRentLedger(model: string, options?: { home?: string }): Promise<RentLine[]>;

/** TUI2-R3v2 ③ (the safer-options seam, adjudicated 2026-08-18) — the
 *  SIDE-QUERY arm. A side query sends its own short system prompt and
 *  nothing else: no extension appends, no tools. Synchronous because
 *  there is no composition to resolve. */
export function predictSideQueryRentLedger(model: string, systemPrompt: string): RentLine[];
