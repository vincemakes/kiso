/**
 * The published type surface of @vincemakes/kiso-mcp-ext: the default
 * export is the FACTORY (the same contract the user-layer disk loader
 * accepts — a KisoExtension or a factory returning one). The type import
 * from kiso-core is compile-time only — the shipped bundle is
 * self-contained, zero runtime dependencies.
 */
import type { KisoExtension } from "@vincemakes/kiso-core";

declare const createMcpExtension: () => KisoExtension | Promise<KisoExtension>;
export default createMcpExtension;
