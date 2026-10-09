// Positive and negative controls for verify.mjs, using the scripted oracle
// against the real server (no model, no spend). Also: every task is feasible
// inside its budget on every seed the benchmark may use, and the oracle's
// cheapest route is recorded as the waste baseline.
// Run: node bench/tests/test_mcp_ptc_verify.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { solve, solvePartialDeep, startServer } from "../mcp-ptc/oracle.mjs";

const V = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp-ptc", "verify.mjs");
const dir = mkdtempSync(join(tmpdir(), "mcp-ptc-verify-"));
const verdict = (task, snap, answer) => { const a = join(dir, `a-${Math.random().toString(36).slice(2)}.txt`); writeFileSync(a, answer); return execFileSync("node", [V, task, snap, a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); };

const baseline = {};
for (const seed of ["mcp-ptc-1", "mcp-ptc-2", "mcp-ptc-3", "mcp-ptc-4", "mcp-ptc-5", "mcp-ptc-6"]) {
	for (const task of ["SHORT", "MID", "DEEP"]) {
		const snap = join(dir, `${seed}-${task}.json`);
		const c = startServer({ MCP_SEED: seed, MCP_SNAPSHOT: snap });
		await c.rpc("initialize", {});
		const answer = await solve(task, c);
		const calls = c.calls();
		await c.close();
		assert.equal(verdict(task, snap, answer), "pass", `${task} on ${seed}: the oracle must pass`);
		if (task !== "MID") assert.equal(verdict(task, snap, "nothing useful"), "fail", `${task}: a state-correct run with a wrong answer must not pass`);
		baseline[task] = Math.max(baseline[task] ?? 0, calls);
	}
}

// negatives: nothing done, and a deep run that stops before the gate
const none = join(dir, "none.json");
const n = startServer({ MCP_SNAPSHOT: none }); await n.rpc("initialize", {}); await n.close();
for (const task of ["SHORT", "MID", "DEEP"]) assert.equal(verdict(task, none, "nothing"), "fail", `${task}: an untouched world must fail`);
const part = join(dir, "partial.json");
const p = startServer({ MCP_SNAPSHOT: part }); await p.rpc("initialize", {});
const ans = await solvePartialDeep(p); await p.close();
assert.equal(verdict("DEEP", part, ans), "fail", "a deep run that never finalizes must fail");

console.log(`test_mcp_ptc_verify: ok (oracle max calls over 6 seeds: ${JSON.stringify(baseline)})`);
