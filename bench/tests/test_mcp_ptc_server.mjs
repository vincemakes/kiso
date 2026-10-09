// The benchmark's mock MCP server, driven by a scripted client over stdio
// (no model, no spend). Run: node bench/tests/test_mcp_ptc_server.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "mcp-ptc", "server.mjs");
const dir = mkdtempSync(join(tmpdir(), "mcp-ptc-"));

function client(env = {}) {
	const snap = join(dir, `snap-${Math.random().toString(36).slice(2)}.json`);
	const p = spawn("node", [SERVER], { env: { ...process.env, MCP_SNAPSHOT: snap, ...env }, stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map(); let id = 1;
	createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
	const rpc = (method, params) => new Promise((res) => { const i = id++; waiting.set(i, res); p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`); });
	const call = async (name, args = {}) => { const r = (await rpc("tools/call", { name, arguments: args })).result; return { error: r.isError === true, body: JSON.parse(r.content[0].text) }; };
	return { rpc, call, snap, close: () => new Promise((res) => { p.on("exit", res); p.stdin.end(); }), read: () => JSON.parse(readFileSync(snap, "utf8")) };
}

// 1. the catalog scales and the declarations are realistic in size
for (const n of [13, 40, 120]) {
	const c = client({ MCP_TOOLS: String(n) });
	await c.rpc("initialize", { protocolVersion: "2025-06-18" });
	const { tools } = (await c.rpc("tools/list")).result;
	assert.equal(tools.length, n);
	assert.equal(new Set(tools.map((t) => t.name)).size, n, "tool names must be unique");
	if (n === 120) {
		const pad = tools.slice(13);
		const avg = pad.reduce((s, t) => s + JSON.stringify(t).length, 0) / pad.length;
		assert.ok(avg > 700 && avg < 1400, `padding declarations average ${avg} bytes`);
	}
	await c.close();
}

// 2. the whole chain works, with real data dependencies and a gate
const c = client({ MCP_TOOLS: "13" });
await c.rpc("initialize", {});
const proj = (await c.call("create_project", { name: "Atlas", budget_credits: 200 })).body.project_id;
const subs = [];
for (const n of ["A", "B", "C", "D", "E", "F"]) subs.push((await c.call("add_subject", { project_id: proj, name: n })).body.subject_id);
const assets = [];
for (const s of subs) assets.push((await c.call("generate_asset", { subject_id: s, style: "noir", call_id: `g-${s}` })).body.asset_id);
// a repeated call_id replays and charges nothing
const before = (await c.call("wallet_balance", { project_id: proj })).body.spent;
const again = await c.call("generate_asset", { subject_id: subs[0], style: "noir", call_id: `g-${subs[0]}` });
assert.equal(again.body.replayed, true);
assert.equal((await c.call("wallet_balance", { project_id: proj })).body.spent, before, "a replayed call_id must not charge");
// the gate: no board, no approval; below-threshold assets cannot be arranged
assert.equal((await c.call("request_approval", { project_id: proj })).body.error, "no_board");
let failing = 0;
for (const a of assets) {
	let r = (await c.call("analyze_asset", { asset_id: a })).body;
	if (!r.passes) {
		failing += 1;
		assert.ok(r.issues.length >= 1, "a failing asset must name its issues");
		const vague = (await c.call("revise_asset", { asset_id: a, instruction: "make it better" })).body;
		const fixed = (await c.call("revise_asset", { asset_id: a, instruction: `fix ${r.issues.join(" and ")}` })).body;
		r = (await c.call("analyze_asset", { asset_id: a })).body;
		assert.ok(r.score > 0 && fixed.revision === vague.revision + 1);
	}
}
assert.ok(failing >= 1, "the seed must produce at least one asset that needs revision");
// revise until everything passes (a vague revision adds little; naming the issues adds a lot)
for (let round = 0; round < 6; round += 1) {
	const bad = (await c.call("list_assets", { project_id: proj, needs_revision: true, compact: true })).body.assets;
	if (!bad.length) break;
	for (const a of bad) { const r = (await c.call("analyze_asset", { asset_id: a.asset_id })).body; await c.call("revise_asset", { asset_id: a.asset_id, instruction: `fix ${r.issues.join(" ")}` }); }
}
assert.equal((await c.call("list_assets", { project_id: proj, needs_revision: true })).body.assets.length, 0);
assert.equal((await c.call("finalize_project", { project_id: proj, approval_token: "nope" })).body.error, "not_approved");
assert.equal((await c.call("arrange_board", { project_id: proj, asset_ids: assets })).error, false);
const tok = (await c.call("request_approval", { project_id: proj })).body.approval_token;
assert.equal((await c.call("finalize_project", { project_id: proj, approval_token: tok })).body.state, "final");
assert.equal((await c.call("add_subject", { project_id: proj, name: "late" })).body.error, "project_closed");
const s1 = c.read();
assert.equal(s1.projects[proj].state, "final");
assert.ok(s1.ledger.filter((l) => l.kind === "settle").length >= 8 && s1.calls.generate_asset >= 7);
await c.close();

// 3. validation and budget
const d = client();
await d.rpc("initialize", {});
assert.equal((await d.call("add_subject", {})).body.error, "invalid_arguments");
assert.equal((await d.call("nope")).body.error, "unknown_tool");
const tiny = (await d.call("create_project", { name: "T", budget_credits: 6 })).body.project_id;
const sub = (await d.call("add_subject", { project_id: tiny, name: "x" })).body.subject_id;
assert.equal((await d.call("generate_asset", { subject_id: sub, style: "s" })).error, false);
assert.equal((await d.call("generate_asset", { subject_id: sub, style: "s" })).body.error, "insufficient_credits");
await d.close();

// 4. determinism and the volume knob
const sizes = {};
for (const v of ["small", "medium", "large"]) {
	const e = client({ MCP_VOLUME: v });
	await e.rpc("initialize", {});
	sizes[v] = JSON.stringify((await e.call("list_assets", { project_id: "p_2" })).body).length;
	const again2 = JSON.stringify((await e.call("list_assets", { project_id: "p_2" })).body).length;
	assert.equal(sizes[v], again2);
	await e.close();
}
assert.ok(sizes.small < sizes.medium && sizes.medium < sizes.large, JSON.stringify(sizes));
assert.ok(sizes.small < 2000 && sizes.medium > 5000 && sizes.medium < 9000 && sizes.large > 18000 && sizes.large < 30000, `volume sizes ${JSON.stringify(sizes)}`);

// 5. padding tools are real
const f = client({ MCP_TOOLS: "40" });
await f.rpc("initialize", {});
const made = await f.call("calendar_create", { title: "standup", start: "09:00" });
assert.equal(made.error, false);
assert.equal((await f.call("calendar_get", { id: made.body.id })).body.title, "standup");
assert.equal((await f.call("calendar_get", { id: "calendar_999" })).body.error, "not_found");
await f.close();
console.log(`test_mcp_ptc_server: ok (list_assets p_2 bytes: ${JSON.stringify(sizes)})`);
