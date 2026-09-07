/**
 * CT-1 (ADR-0051 Amendment 6, D2) — the runtime's two `compaction` mirror
 * fields existed only to forward the loop's ignored field and went with
 * it. Same gate shape as core's ct1-retired-surface.test.ts: each
 * constant compiles only while the member is absent. (The 2026-09-07
 * review: the core gate alone did not cover these two.)
 */

import { describe, expect, it } from "vitest";
import type { AgentDefinition, SessionConfig } from "../src/index.js";

type Has<T, K extends string> = K extends keyof T ? true : false;

const agentCompaction: Has<AgentDefinition, "compaction"> = false;
const sessionCompaction: Has<SessionConfig, "compaction"> = false;

describe("CT-1 — the runtime's retired mirror fields", () => {
	it("AgentDefinition.compaction and SessionConfig.compaction are absent (the typecheck is the gate)", () => {
		expect(agentCompaction).toBe(false);
		expect(sessionCompaction).toBe(false);
	});
});
