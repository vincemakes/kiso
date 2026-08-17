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

/** The panel bridge the CLI implements over its editor's panel slot. */
export interface AskUI {
	ask(spec: AskSpec, signal?: { readonly aborted: boolean }): Promise<AskResult>;
}

declare const createAskExtension: (ui?: AskUI) => Promise<KisoExtension>;
export default createAskExtension;
export declare const ASK_PARAMETERS: Readonly<Record<string, unknown>>;
