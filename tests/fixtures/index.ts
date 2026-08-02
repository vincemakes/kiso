import type { Fixture } from "./types";
import { terminalLies } from "./terminal-lies";
import { silentToolFailure } from "./silent-tool-failure";
import { compactionRegrowth } from "./compaction-regrowth";

/** The accident library — every fixture is a real incident abstracted. */
export const FIXTURES: readonly Fixture[] = [
	terminalLies,
	silentToolFailure,
	compactionRegrowth,
];

export * from "./types";
export { runStaticFixture, flattenScript } from "./runner";
