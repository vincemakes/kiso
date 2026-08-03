import type { Fixture } from "./types.js";
import { terminalLies } from "./terminal-lies.js";
import { silentToolFailure } from "./silent-tool-failure.js";
import { compactionRegrowth } from "./compaction-regrowth.js";
import { userAbort } from "./user-abort.js";
import { unknownTool } from "./unknown-tool.js";
import { permissionNegotiation } from "./permission-negotiation.js";

/** The accident library — every fixture is a real incident abstracted. */
export const FIXTURES: readonly Fixture[] = [
	terminalLies,
	silentToolFailure,
	compactionRegrowth,
	userAbort,
	unknownTool,
	permissionNegotiation,
];

export * from "./types.js";
export { terminalLies } from "./terminal-lies.js";
export { silentToolFailure } from "./silent-tool-failure.js";
export { compactionRegrowth } from "./compaction-regrowth.js";
export { userAbort } from "./user-abort.js";
export { unknownTool } from "./unknown-tool.js";
export { permissionNegotiation } from "./permission-negotiation.js";
export { makeAbortSignal } from "./user-abort.js";
export { runStaticFixture, flattenScript } from "./runner.js";
