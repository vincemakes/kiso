/**
 * ACI-6 — the routing policy is stated ONCE.
 *
 * It was stated three times and two of them disagreed: the base prompt
 * said "shell is for commands: builds, tests, git, GREP" while
 * `TOOL_RULES` said "search with search_text, NEVER shell grep/rg". The
 * batching directive was carried verbatim in both. And one line above the
 * batching bullet the prompt said "run one command at a time", which reads
 * as its opposite.
 *
 * `TOOL_RULES` is canonical because it is composed from the ACTIVE
 * registry: it names only tools that exist, one line each, deterministic.
 * The base prompt's copy is static, cannot know which tools are active,
 * and is the copy that drifted.
 *
 * WHAT IS DELETED AND WHY NOTHING IS ADDED. This programme measured a
 * +35% cost regression from a prompt round, traced to REASONING tokens
 * rather than prompt bytes, and recorded that reasoning length depends on
 * WHICH text is present. Deletion is the lowest-exposure class of prompt
 * change, so the fix is deletions only.
 *
 * "Run one command at a time" goes because the KERNEL already guarantees
 * it: a tool that declares no `effects` is EXCLUSIVE and the kernel
 * serialises it behind a FIFO barrier installed at call order
 * (`loop.ts`). `shell` declares none. So batched shell calls already run
 * one at a time, enforced, and the sentence was costing a model round
 * trip per command to restate a machine invariant.
 */

import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../src/index.js";
import { CODING_TOOL_RULES } from "../src/coding-prompt.js";
import { composeToolTable } from "@vincemakes/kiso-runtime/internal";
import { createCodingTools } from "@vincemakes/kiso-tools-node";

const table = (): string => {
	const tools = createCodingTools({ workspaceRoot: "/tmp" });
	return composeToolTable({ list: () => tools } as never, CODING_TOOL_RULES);
};

describe("ACI-6: the routing policy is stated once", () => {
	it("the base prompt no longer routes grep to shell", () => {
		expect(SYSTEM_PROMPT).not.toMatch(/shell is for commands[\s\S]{0,40}grep/i);
	});

	it("and CODING_TOOL_RULES still says never — the canonical copy is unchanged", () => {
		expect(table()).toMatch(/search with search_text, never shell grep\/rg/i);
	});

	it("the batching directive appears EXACTLY ONCE across prompt and table", () => {
		const both = `${SYSTEM_PROMPT}\n${table()}`;
		const hits = both.match(/batch independent tool calls/gi) ?? [];
		expect(hits, `found ${hits.length}`).toHaveLength(1);
	});

	// MOVED (2026-10-11, the P1.3 prompt): the base prompt no longer
	// carries the caution; the shell tool's own description does, once —
	// still on every request, still not duplicated.
	it("the shell CAUTION survives — it is not duplicated and not what contradicted", () => {
		const { description } = createCodingTools({ workspaceRoot: "/tmp" }).find((t) => t.name === "shell")!;
		expect(description).toMatch(/side effects are real/i);
		expect(`${SYSTEM_PROMPT}\n${table()}\n${description}`.match(/side effects/gi) ?? []).toHaveLength(1);
	});

	it("'one command at a time' is gone — the kernel enforces it, the prompt was paying for it", () => {
		expect(SYSTEM_PROMPT).not.toMatch(/one command at a time/i);
	});

	// The kernel invariant the deletion relies on. If this ever goes red the
	// deletion loses its justification, so it is asserted here rather than
	// left as a claim in a commit message.
	it("shell declares no concurrency, so the kernel serialises it", async () => {
		const { createCodingTools: make } = await import("@vincemakes/kiso-tools-node");
		const shell = make({ workspaceRoot: "/tmp" }).find((t) => t.name === "shell");
		expect(shell, "shell is in the default set").toBeDefined();
		expect(shell!.effects?.concurrency).not.toBe("shared");
	});
});

describe("ACI-6: what this round must NOT touch", () => {
	// DECLARED SUPERSESSION (2026-10-11, the P1.3 prompt — kiso-doc
	// report-p13-confirm-and-fidelity-2026-10-11). Both texts these guards
	// held byte-identical were replaced, each by a measured successor:
	//   - the reach section -> the reach paragraph, pinned with its
	//     measurement in pr1d-clause-pins.test.ts (Capability Fidelity
	//     48/48 against 0.49.0's 48/48);
	//   - the 0.37.0 re-read bullet -> the observation-continuity
	//     paragraph, measured with the hidden observed revision (O1.1):
	//     T6 turn-start post-edit re-reads 66 -> 56 in the P1.3 round,
	//     87 -> 13 in the P1.2 round, no task-success regression.
	it("the observation-continuity paragraph replaces the re-read bullet", () => {
		expect(SYSTEM_PROMPT).toContain(
			"After a successful edit or write, treat the change you made and the returned revision as the file's current observed state.",
		);
		expect(SYSTEM_PROMPT).toContain("A confirmed tool result is evidence; do not re-read or re-check solely for reassurance.");
	});
});
