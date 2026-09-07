/**
 * CT-1 (ADR-0051 Amendment 6, ADR-0043 Amendment 12) — the retired
 * kernel configuration surface stays retired.
 *
 * Every member below was compat-debt with no reader (Amendment 11's
 * ledger): `LoopConfig.compaction` (ignored since ADR-0044),
 * `resolveUncertainty` / `uncertaintyVerdict` (dead since ADR-0038),
 * `HookHost.onPreCompact` / `onPostCompact` (never fired),
 * `modes` / `mode` with `ModeProfile` / `resolveModeProfile` and
 * `ToolRegistry.subset()` (no caller). The gate is the TYPECHECK: each
 * constant compiles only while its member is absent — a present member
 * makes the type `true`, and `false` is not assignable to `true`.
 * Red first: on the pre-CT-1 tree all nine failed to compile.
 */

import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";
import type { HookHost, LoopConfig, ToolRegistry } from "../src/index.js";

type Has<T, K extends string> = K extends keyof T ? true : false;

const loopModes: Has<LoopConfig, "modes"> = false;
const loopMode: Has<LoopConfig, "mode"> = false;
const loopCompaction: Has<LoopConfig, "compaction"> = false;
const loopResolveUncertainty: Has<LoopConfig, "resolveUncertainty"> = false;
const loopUncertaintyVerdict: Has<LoopConfig, "uncertaintyVerdict"> = false;
const hookPreCompact: Has<HookHost, "onPreCompact"> = false;
const hookPostCompact: Has<HookHost, "onPostCompact"> = false;
const registrySubset: Has<ToolRegistry, "subset"> = false;
const exportResolveModeProfile: Has<typeof core, "resolveModeProfile"> = false;

describe("CT-1 — the retired kernel surface", () => {
	it("nine retired members are absent (the typecheck is the gate; this run only records it)", () => {
		for (const absent of [loopModes, loopMode, loopCompaction, loopResolveUncertainty, loopUncertaintyVerdict, hookPreCompact, hookPostCompact, registrySubset, exportResolveModeProfile]) {
			expect(absent).toBe(false);
		}
	});
});
