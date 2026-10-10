#!/usr/bin/env node
/**
 * audit-plans.mjs <run dir> <worktree root> — A1, the offline trace audit (no model, no spend).
 *
 * For every leg of an MCP-benchmark round it reads the session record and answers:
 *   - how many program/plan calls, how many were only discovery, how many did work;
 *   - for each plan that did work: node count, calls, the widest overlap and the critical path the
 *     engine would have given it (re-run offline against the leg's RECORDED tool results, virtual
 *     20 ms per call, host-declared effects);
 *   - why the model split its work: ids copied from an earlier result, a decision on a result, discovery;
 *   - what each build error cost (output tokens of the request that wrote it, plus the extra request);
 *   - the billing sums per arm, and the consistency of the round (pairing, request totals).
 * REPORT ONLY. The split-reason classifier is a heuristic, stated as such in the output.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { studioEffects } from "./studio-effects.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = process.argv[2], ROOT = process.argv[3];
if (!RUN || !ROOT) { console.error("usage: audit-plans.mjs <run dir> <worktree root>"); process.exit(2); }
const { buildPlan, runIr } = await import(pathToFileURL(join(ROOT, "extensions/program/dist/kiso-program.mjs")).href);
const TICK = 20;
const CELLS = JSON.parse(readFileSync(join(HERE, "..", "mcp-ptc", "cells.json"), "utf8"));

async function catalogFor(tools) {
	const p = spawn(process.execPath, [join(HERE, "..", "mcp-ptc", "server.mjs")], { env: { ...process.env, MCP_TOOLS: String(tools), MCP_SNAPSHOT: "" }, stdio: ["pipe", "pipe", "inherit"] });
	const list = await new Promise((resolve) => {
		createInterface({ input: p.stdout }).on("line", (l) => { const m = JSON.parse(l); if (m.id === 1) resolve(m.result.tools); });
		p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
	});
	p.kill();
	return list.map((t) => ({ name: `mcp__studio__${t.name}`, description: t.description, inputSchema: t.inputSchema }));
}
const catalogs = {};
const catalog = async (cell) => (catalogs[cell] ??= await catalogFor(CELLS[cell].tools));

const med = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const idsIn = (text) => new Set(String(text).match(/\b(?:p|s|a|r|b|ap)_[0-9a-f]+\b/g) ?? []);
const parse = (c) => { try { return JSON.parse(c); } catch { return c; } };

function readLeg(dir) {
	const m = /^kiso-(\w+)-(K-[a-z-]+?)-r(\d+)$/.exec(dir.split("/").pop());
	if (!m) return null;
	const [, cell, arm, rep] = m;
	const f = join(dir, "kiso-home", "sessions", `bench-t6-kiso-${arm}-r${rep}.jsonl`);
	if (!existsSync(f)) return null;
	const ev = readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => { const o = JSON.parse(l); return o.event ?? o; });
	const metrics = JSON.parse(readFileSync(join(dir, "mcp-metrics.json"), "utf8"));
	const tops = [], kids = new Map(); // kids: parent callId -> children in start order
	let lastUsage = null; const byExec = new Map(); let inflight = 0, maxIn = 0;
	for (const e of ev) {
		if (e.type === "usage") lastUsage = e;
		if (e.type === "tool_execution_started") {
			const top = !String(e.callId).includes("/");
			if (top) { const t = { callId: e.callId, name: e.name, code: e.input?.code ?? "", usage: lastUsage, children: [], exec: e.executionId }; tops.push(t); byExec.set(e.executionId, t); }
			else { const parent = String(e.callId).split("/")[0]; const k = { callId: e.callId, name: e.name, input: e.input, exec: e.executionId, seq: e.seq }; (kids.get(parent) ?? kids.set(parent, []).get(parent)).push(k); byExec.set(e.executionId, k); if (++inflight > maxIn) maxIn = Math.max(maxIn, inflight); }
		}
		if ((e.type === "tool_execution_succeeded" || e.type === "tool_execution_failed") && byExec.has(e.executionId)) {
			const x = byExec.get(e.executionId);
			if (x.callId.includes("/")) inflight--;
			x.ok = e.type === "tool_execution_succeeded"; x.out = e.result?.content ?? e.error;
		}
		if (e.type === "tool_result" && !String(e.callId).includes("/")) { const t = tops.find((y) => y.callId === e.callId); if (t) { t.result = e.content; t.isError = e.isError === true; } }
	}
	for (const t of tops) t.children = kids.get(t.callId) ?? [];
	return { dir, cell, arm, rep: Number(rep), tops, metrics, maxIn };
}

const classify = (leg, t) => {
	if (leg.arm === "K-plan" && t.isError && /plan code error|invalid plan|too many steps/.test(String(t.result))) return "build_error";
	const hasCalls = leg.arm === "K-plan" ? /\bcall\s*\(/.test(t.code) : /\btools\.\w+\s*\(|tools\[/.test(t.code);
	if (!hasCalls) return "discovery";
	return "work";
};

async function replay(leg, t) {
	const q = new Map();
	for (const k of t.children) { const key = `${k.name}\n${JSON.stringify(k.input ?? {})}`; (q.get(key) ?? q.set(key, []).get(key)).push(k.ok === false ? { ok: false, error: String(k.out) } : { ok: true, value: parse(String(k.out ?? "")) }); }
	const plan = await buildPlan(t.code, await catalog(leg.cell));
	if (!plan.ok) return { error: plan.error };
	let misses = 0;
	const countNodes = (ns) => ns.reduce((n, x) => n + 1 + (x.body ? countNodes(x.body) : 0), 0);
	const t0 = Date.now();
	const r = await runIr(plan.program, {
		mode: "parallel", maxConcurrency: 8, effects: studioEffects,
		call: async (tool, args) => { await new Promise((res) => setTimeout(res, TICK)); const a = q.get(`${tool}\n${JSON.stringify(args ?? {})}`); const v = a?.length > 1 ? a.shift() : a?.[0]; if (!v) { misses++; return { ok: false, error: "replay miss" }; } return v; },
	});
	const elapsed = Date.now() - t0;
	return { nodes: countNodes(plan.program.nodes), calls: r.started.length, width: r.maxInFlight, levels: Math.max(1, Math.round(elapsed / TICK)), misses, errors: r.errors.length };
}

const legs = readdirSync(RUN).filter((d) => d.startsWith("kiso-")).map((d) => readLeg(join(RUN, d))).filter(Boolean);
legs.sort((a, b) => a.cell.localeCompare(b.cell) || a.arm.localeCompare(b.arm) || a.rep - b.rep);

const out = { legs: [] };
for (const leg of legs) {
	const rows = []; const seenIds = new Set(); let prevWork = null; let workIndex = 0;
	for (const t of leg.tops) {
		if (t.name !== "plan" && t.name !== "program") continue;
		const kind = classify(leg, t);
		const row = { kind, calls: t.children.length, codeChars: t.code.length, outTokens: t.usage?.outputTokens ?? null, inTokens: t.usage?.inputTokens ?? null, cacheRead: t.usage?.cacheRead ?? null };
		if (kind === "work") {
			const lit = [...idsIn(t.code)]; const copied = lit.filter((i) => seenIds.has(i));
			row.copiedIds = copied.length;
			const tools = new Set(t.children.map((k) => k.name.replace("mcp__studio__", "")));
			row.tools = [...tools];
			if (workIndex === 0) row.split = "first";
			else if (copied.length === 0) row.split = "independent";
			else if (prevWork && prevWork.tools.some((x) => ["analyze_asset", "list_assets", "list_subjects", "wallet_balance", "get_asset", "get_subject"].includes(x)) && row.tools.some((x) => ["revise_asset", "arrange_board", "request_approval", "finalize_project", "generate_asset"].includes(x))) row.split = "decision";
			else row.split = "id-copy";
			if (leg.arm === "K-plan") { const rp = await replay(leg, t); Object.assign(row, { replay: rp }); }
			else { row.promiseAll = /Promise\.all|Promise\.allSettled/.test(t.code); row.seqAwaitLoop = /for\s*\([^)]*\)\s*\{[^}]*await\s+tools/.test(t.code); }
			prevWork = row; workIndex++;
		}
		if (kind === "build_error") row.errorText = String(t.result).slice(0, 80);
		if (kind === "discovery") row.catalogDump = /ALL_TOOLS\s*[;)]|output\(\s*ALL_TOOLS|return\s+ALL_TOOLS/.test(t.code);
		for (const k of t.children) for (const i of idsIn(k.out ?? "")) seenIds.add(i);
		for (const i of idsIn(t.result ?? "")) seenIds.add(i);
		rows.push(row);
	}
	out.legs.push({ leg: leg.dir.split("/").pop(), cell: leg.cell, arm: leg.arm, rep: leg.rep, observedMaxInFlight: leg.maxIn, metrics: leg.metrics, programs: rows });
}
writeFileSync(join(RUN, "audit-plans.json"), JSON.stringify(out, null, 1));

// ── report ──────────────────────────────────────────────────────────────────
const ARMS = ["K-program", "K-program-index", "K-plan"];
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "n/a");
console.log("# A1 trace audit\n");
console.log("## 1. Round consistency");
const ledger = readFileSync(join(RUN, "ledger.tsv"), "utf8").trim().split("\n").slice(1).map((l) => l.split("\t"));
console.log(`- ledger rows: ${ledger.length}; requests total: ${sum(ledger.map((r) => Number(r[4])))} (rep1 ${sum(ledger.filter((r) => r[3] === "1").map((r) => Number(r[4])))}); voided: ${ledger.filter((r) => r[8] !== "-").length}`);
const reqSum = sum(out.legs.map((l) => l.metrics.requests));
console.log(`- sum of per-leg metrics.requests: ${reqSum}`);
const inst = {};
for (const c of ["base", "ddeep", "host", "s120"]) { const p = join(RUN, `inst-${c}`, "instance.json"); if (existsSync(p)) inst[c] = readFileSync(p, "utf8").trim(); }
console.log(`- instances (one per cell, shared by all arms and reps, hence paired by construction): ${Object.keys(inst).join(", ")}`);
const kit = "/Users/vinve/Desktop/devv/kiso-doc/kit-ir-experiment-A-2026-10-10.md";
if (existsSync(kit)) { const firstLeg = Math.min(...legs.map((l) => statSync(join(l.dir, "mcp-metrics.json")).birthtimeMs)); console.log(`- kit file last modified ${new Date(statSync(kit).mtimeMs).toISOString()}; first leg metrics written ${new Date(firstLeg).toISOString()} (kit before legs: ${statSync(kit).mtimeMs < firstLeg})`); }

console.log("\n## 2. Billing by arm (sums over the 12 legs of each arm)");
console.log("| arm | legs | requests | fresh in | cache read | output | cache share | usd |\n|---|---|---|---|---|---|---|---|");
for (const a of ARMS) { const ls = out.legs.filter((l) => l.arm === a); const m = (k) => sum(ls.map((l) => l.metrics[k] ?? 0)); console.log(`| ${a} | ${ls.length} | ${m("requests")} | ${m("fresh")} | ${m("cacheRead")} | ${m("output")} | ${f(100 * m("cacheRead") / (m("cacheRead") + m("fresh")), 0)}% | ${f(m("usd"), 4)} |`); }

console.log("\n## 3. What the programs/plans were (per arm, all 12 legs)");
console.log("| arm | program calls | discovery-only | catalog dumps | build errors | work calls | tool calls total | tool calls / work call | observed max overlap (median) |\n|---|---|---|---|---|---|---|---|---|");
for (const a of ARMS) {
	const ls = out.legs.filter((l) => l.arm === a); const ps = ls.flatMap((l) => l.programs);
	const w = ps.filter((p) => p.kind === "work");
	console.log(`| ${a} | ${ps.length} | ${ps.filter((p) => p.kind === "discovery").length} | ${ps.filter((p) => p.catalogDump).length} | ${ps.filter((p) => p.kind === "build_error").length} | ${w.length} | ${sum(w.map((p) => p.calls))} | ${f(sum(w.map((p) => p.calls)) / Math.max(1, w.length))} | ${med(ls.map((l) => l.observedMaxInFlight))} |`);
}

console.log("\n## 4. Why the work was split (work calls after the first, per arm; heuristic classifier)");
console.log("`id-copy`: the code contains ids the model copied from an earlier result and no decision was pending; `decision`: the previous call read state (analyze/list/...) and this one acts on it; `independent`: no id from earlier results.");
console.log("| arm | work calls | first | id-copy | decision | independent |\n|---|---|---|---|---|---|");
for (const a of ARMS) { const w = out.legs.filter((l) => l.arm === a).flatMap((l) => l.programs).filter((p) => p.kind === "work"); const c = (s) => w.filter((p) => p.split === s).length; console.log(`| ${a} | ${w.length} | ${c("first")} | ${c("id-copy")} | ${c("decision")} | ${c("independent")} |`); }

console.log("\n## 5. The engine's share: plans replayed offline on the recorded results (K-plan only)");
const pw = out.legs.filter((l) => l.arm === "K-plan").flatMap((l) => l.programs.map((p) => ({ ...p, cell: l.cell }))).filter((p) => p.kind === "work" && p.replay && !p.replay.error);
console.log(`- work plans replayed: ${pw.length}; replay misses (a call whose args differ from the recorded run): ${sum(pw.map((p) => p.replay.misses))}; builds that failed on replay: ${out.legs.filter((l) => l.arm === "K-plan").flatMap((l) => l.programs).filter((p) => p.kind === "work" && p.replay?.error).length}`);
console.log("| cell | work plans | calls | critical path (levels) | calls/levels | widest overlap (max) | plans with ≥1 call | plans with calls = 1 | plans with width>1 |\n|---|---|---|---|---|---|---|---|---|");
for (const c of ["base", "ddeep", "host", "s120", "ALL"]) { const x = pw.filter((p) => c === "ALL" || p.cell === c); console.log(`| ${c} | ${x.length} | ${sum(x.map((p) => p.replay.calls))} | ${sum(x.map((p) => p.replay.levels))} | ${f(sum(x.map((p) => p.replay.calls)) / Math.max(1, sum(x.map((p) => p.replay.levels))), 2)} | ${Math.max(0, ...x.map((p) => p.replay.width))} | ${x.length} | ${x.filter((p) => p.replay.calls === 1).length} | ${x.filter((p) => p.replay.width > 1).length} |`); }
const hist = {}; for (const p of pw) hist[p.replay.calls] = (hist[p.replay.calls] ?? 0) + 1;
console.log(`- calls per work plan (histogram): ${JSON.stringify(hist)}`);
console.log(`- node count per work plan: median ${med(pw.map((p) => p.replay.nodes))}, max ${Math.max(0, ...pw.map((p) => p.replay.nodes))}`);

console.log("\n## 6. Cost of build errors (K-plan)");
const be = out.legs.filter((l) => l.arm === "K-plan").flatMap((l) => l.programs).filter((p) => p.kind === "build_error");
const msgs = {}; for (const p of be) msgs[p.errorText] = (msgs[p.errorText] ?? 0) + 1;
console.log(`- build errors: ${be.length}; messages: ${JSON.stringify(msgs)}`);
console.log(`- output tokens of the requests that wrote them: ${sum(be.map((p) => p.outTokens ?? 0))}; each also costs one extra request (the retry): ${be.length}`);
const totalOutPlan = sum(out.legs.filter((l) => l.arm === "K-plan").map((l) => l.metrics.output)), totalUsdPlan = sum(out.legs.filter((l) => l.arm === "K-plan").map((l) => l.metrics.usd));
console.log(`- share of K-plan output tokens: ${f(100 * sum(be.map((p) => p.outTokens ?? 0)) / totalOutPlan, 1)}%; K-plan total usd ${f(totalUsdPlan, 4)}`);

const kern = out.legs.map((l) => l.observedMaxInFlight);
console.log(`\n## 6b. Overlap that really happened in the kernel (child executions started but not yet receipted, max per leg): all ${kern.length} legs, all arms: max ${Math.max(...kern)}, legs above 1: ${kern.filter((x) => x > 1).length}. The engine asked for up to ${Math.max(0, ...pw.map((p) => p.replay.width))} at once.`);
console.log("\n## 7. JS arms: how did the model order its independent calls?");
for (const a of ["K-program", "K-program-index"]) { const w = out.legs.filter((l) => l.arm === a).flatMap((l) => l.programs).filter((p) => p.kind === "work"); console.log(`- ${a}: work programs ${w.length}; use Promise.all: ${w.filter((p) => p.promiseAll).length}; await inside a for-loop: ${w.filter((p) => p.seqAwaitLoop).length}; single-call programs: ${w.filter((p) => p.calls === 1).length}`); }
console.log("\n(json: audit-plans.json in the run directory)");
