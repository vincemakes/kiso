/**
 * The published type surface of @vincemakes/kiso-ask-ext: the default
 * export is the FACTORY, and it takes the PANEL BRIDGE. That parameter is
 * the TTY gate made structural — a caller with no way to ask a human has
 * nothing to pass, and the extension it gets back contributes no tool.
 *
 * The type imports are compile-time only — the shipped bundle is
 * self-contained, zero runtime dependencies.
 */
import type { KisoExtension } from "@vincemakes/kiso-core";
import type { AskResult, AskSpec } from "@vincemakes/kiso-tui-cells";

/** Which session and which tool call is asking — the tool context's own
 *  values, passed through. Optional because the context declares them
 *  optional: a direct call of the tool with a bare context gets
 *  `undefined`, never a made-up id. */
export interface AskCallContext {
	readonly sessionId?: string;
	readonly callId?: string;
}

/** The panel bridge. The CLI implements it over its editor's panel slot
 *  and ignores `ctx`; a host serving many sessions from one runtime reads
 *  `ctx` to route the question to the right session. */
export interface AskUI {
	ask(spec: AskSpec, signal?: { readonly aborted: boolean }, ctx?: AskCallContext): Promise<AskResult>;
}

declare const createAskExtension: (ui?: AskUI) => Promise<KisoExtension>;
export default createAskExtension;
export declare const ASK_PARAMETERS: Readonly<Record<string, unknown>>;
