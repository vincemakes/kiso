import type { ToolSpec } from "@vincemakes/kiso-core";

/** The tools the front-ends themselves are: never part of what a script/plan discovers (they would print their own long descriptions back). */
const FRONT_ENDS = new Set(["program", "plan"]);
export const discoverable = (catalog: readonly ToolSpec[]): ToolSpec[] => catalog.filter((t) => !FRONT_ENDS.has(t.name));
