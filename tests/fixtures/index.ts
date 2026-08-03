import type { Fixture } from "./types";
import { terminalLies } from "./terminal-lies";
import { silentToolFailure } from "./silent-tool-failure";
import { compactionRegrowth } from "./compaction-regrowth";
import { userAbort } from "./user-abort";
import { unknownTool } from "./unknown-tool";
import { permissionNegotiation } from "./permission-negotiation";

/** The accident library — every fixture is a real incident abstracted. */
export const FIXTURES: readonly Fixture[] = [
	terminalLies,
	silentToolFailure,
	compactionRegrowth,
	userAbort,
	unknownTool,
	permissionNegotiation,
];

export * from "./types";
export { runStaticFixture, flattenScript } from "./runner";
