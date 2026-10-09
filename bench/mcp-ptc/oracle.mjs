/**
 * oracle.mjs — a scripted solver for each task, driven over the real stdio
 * protocol against the real server. It exists for three reasons and is NOT an
 * arm of the benchmark:
 *   1. it proves each task is feasible inside its budget (a task no route can
 *      finish would measure nothing),
 *   2. it fixes the cheapest route, so waste (credits and calls beyond it) is
 *      measured against something,
 *   3. it is the positive control for verify.mjs.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const SERVER = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

export function startServer(env = {}) {
	const p = spawn("node", [SERVER], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
	const waiting = new Map(); let id = 1; let calls = 0;
	createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); waiting.get(m.id)?.(m); });
	const rpc = (method, params) => new Promise((res) => { const i = id++; waiting.set(i, res); p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method, params })}\n`); });
	const call = async (name, args = {}) => { calls += 1; const r = (await rpc("tools/call", { name, arguments: args })).result; return { error: r.isError === true, body: JSON.parse(r.content[0].text) }; };
	return { rpc, call, calls: () => calls, close: () => new Promise((res) => { p.on("exit", res); p.stdin.end(); }), snapshot: (path) => JSON.parse(readFileSync(path, "utf8")) };
}

async function build(c, name, budget, subjects, { board, finalize }) {
	const proj = (await c.call("create_project", { name, budget_credits: budget })).body.project_id;
	const subs = [];
	for (const n of subjects) subs.push((await c.call("add_subject", { project_id: proj, name: n })).body.subject_id);
	const assets = [];
	for (const s of subs) assets.push((await c.call("generate_asset", { subject_id: s, style: "noir", call_id: `g-${s}` })).body.asset_id);
	const revised = [];
	for (let round = 0; round < 8; round += 1) {
		let bad = 0;
		for (const a of assets) {
			const r = (await c.call("analyze_asset", { asset_id: a })).body;
			if (!r.passes) { bad += 1; if (!revised.includes(a)) revised.push(a); await c.call("revise_asset", { asset_id: a, instruction: `fix ${r.issues.join(" and ")}` }); }
		}
		if (!bad) break;
	}
	let total = null;
	if (board) {
		await c.call("arrange_board", { project_id: proj, asset_ids: assets, layout: "grid" });
		const tok = (await c.call("request_approval", { project_id: proj, summary: "ready" })).body.approval_token;
		if (finalize) await c.call("finalize_project", { project_id: proj, approval_token: tok });
	}
	total = (await c.call("wallet_balance", { project_id: proj })).body.spent;
	return { revised, total };
}

export async function solve(task, c) {
	if (task === "SHORT") {
		const sid = (await c.call("add_subject", { project_id: "p_1", name: "Wind Cartographer" })).body.subject_id;
		await c.call("generate_asset", { subject_id: sid, style: "noir" });
		const w = (await c.call("wallet_balance", { project_id: "p_1" })).body;
		return `Harbor has ${w.remaining} credits left.`;
	}
	if (task === "MID") {
		const { revised } = await build(c, "Atlas", 200, ["Brass Heron", "Quiet Engine", "Glass Orchard", "Salt Lantern", "Hollow Drum", "Night Ferry"], { board: false });
		return `All six pass. Revised: ${revised.join(", ") || "none"}.`;
	}
	const { total } = await build(c, "Meridian", 250, ["Copper Gull", "Tide Clerk", "Ash Piano", "Velvet Lamp", "Stone Violin", "Reed Cartographer", "Marrow Clock", "Pale Harbor", "Iron Orchid", "Dust Archive", "Lantern Fox", "Kelp Bishop"], { board: true, finalize: true });
	return `Finalized. Total credits spent: ${total}.`;
}

export async function solvePartialDeep(c) { // everything except the gate: must NOT verify
	await build(c, "Meridian", 250, ["Copper Gull", "Tide Clerk", "Ash Piano", "Velvet Lamp", "Stone Violin", "Reed Cartographer", "Marrow Clock", "Pale Harbor", "Iron Orchid", "Dust Archive", "Lantern Fox", "Kelp Bishop"], { board: true, finalize: false });
	return "done";
}
