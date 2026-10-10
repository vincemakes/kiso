#!/usr/bin/env node
/**
 * server.mjs — a deterministic stdio MCP server for the programmatic-tool-
 * calling benchmark. Not a stub: every tool reads and writes real state, the
 * results depend on that state, and the final state is written to a snapshot
 * a verifier can check.
 *
 * Domain: a neutral "studio" — projects own subjects, subjects get generated
 * assets, assets are analysed and revised until they pass, passing assets are
 * arranged on a board, a gate (request_approval -> finalize_project) closes the
 * project. Credits are metered with a ledger; a repeated call_id never charges
 * twice.
 *
 * Environment (the benchmark's knobs):
 *   MCP_SEED       world seed                          (default "mcp-ptc-1")
 *   MCP_TOOLS      total tools offered: 13 | 40 | 120  (default 13)
 *   MCP_VOLUME     small | medium | large  — how rich asset records are
 *   MCP_SNAPSHOT   file written (atomically) after every mutation
 *
 * Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout; initialize,
 * tools/list, tools/call, ping. No dependencies.
 */
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const SEED = process.env.MCP_SEED ?? "mcp-ptc-1";
const NTOOLS = Number(process.env.MCP_TOOLS ?? 13);
const VOLUME = process.env.MCP_VOLUME ?? "small";
const SNAPSHOT = process.env.MCP_SNAPSHOT ?? "";
const PASS_AT = 70;
const COST = { generate: 5, analyze: 1, revise: 3, finalize: 10 };
const ISSUES = ["LIGHT_FLAT", "HAND_ARTIFACT", "TEXT_MISSPELL", "COLOR_CAST", "CROP_TIGHT"];
// MCP_DELAY_AFTER="tool:ms,tool:ms" — answer a call that already took effect only after ms (the crash window)
// MCP_EXIT_AFTER=n — the server process exits right after replying to its n-th tool call (a disconnect in the middle of a program)
const EXIT_AFTER = Number(process.env.MCP_EXIT_AFTER ?? 0);
// MCP_DRIFT_AFTER=n — after n tool calls the signature of add_subject changes server-side (`name` becomes `title`): drift between a program's admission and a later call
const DRIFT_AFTER = Number(process.env.MCP_DRIFT_AFTER ?? 0);
// MCP_LATENCY_MS=n — every tool call is answered n ms after it arrived (calls in flight together are answered together: real concurrency)
const LATENCY = Number(process.env.MCP_LATENCY_MS ?? 0);
let toolCalls = 0;
const DELAY_AFTER = Object.fromEntries((process.env.MCP_DELAY_AFTER ?? "").split(",").filter(Boolean).map((x) => x.split(":")).map(([k, v]) => [k, Number(v)]));
const LOG_LINES = { small: 0, medium: 8, large: 30 }[VOLUME] ?? 0;

const h = (...parts) => createHash("sha256").update([SEED, ...parts].join("|")).digest("hex");
const num = (hex, from, len = 6) => parseInt(hex.slice(from, from + len), 16);

// ── state ────────────────────────────────────────────────────────────────
const S = { projects: {}, subjects: {}, assets: {}, boards: {}, approvals: {}, ledger: [], calls: {}, seen: {}, pad: {}, next: { p: 3, s: 1, a: 1, r: 1, l: 1 } };
const nextId = (k, prefix) => `${prefix}_${S.next[k]++}`;
const ledger = (project, kind, amount, ref) => S.ledger.push({ id: `l_${S.next.l++}`, project, kind, amount, ref });
const spent = (p) => S.ledger.filter((l) => l.project === p && l.kind === "settle").reduce((s, l) => s + l.amount, 0);

function qualityOf(hex) { return 50 + (num(hex, 0) % 46); }
function issuesOf(hex, q) {
	if (q >= PASS_AT) return [];
	const n = 1 + (num(hex, 6, 2) % 2);
	return Array.from({ length: n }, (_, i) => ISSUES[(num(hex, 8 + i * 2, 2) + i) % ISSUES.length]).filter((v, i, a) => a.indexOf(v) === i);
}
function renderLog(hex, rev) {
	return Array.from({ length: LOG_LINES }, (_, i) => `[r${rev}.${String(i).padStart(2, "0")}] pass=${num(hex, i % 20, 4)} tile=${num(hex, (i * 3) % 40, 3)} denoise=${(num(hex, (i * 5) % 50, 3) / 4096).toFixed(4)} sampler=euler_a steps=${20 + (i % 9)} seed=${num(hex, (i * 7) % 56, 6)}`);
}
function makeAsset(subjectId, style, rev, parentHex, instruction) {
	const hex = h("asset", subjectId, style, String(rev), parentHex ?? "", instruction ?? "");
	return { hex, rev, style, instruction: instruction ?? null };
}
function assetView(id, full) {
	const a = S.assets[id];
	const q = a.quality;
	const v = { asset_id: id, subject_id: a.subject, project_id: a.project, style: a.style, revision: a.rev, content_hash: a.hex.slice(0, 16), status: q >= PASS_AT ? "passing" : "needs_revision" };
	if (full || LOG_LINES) { v.render_log = renderLog(a.hex, a.rev); v.history = a.history; }
	return v;
}

function newAsset(project, subject, style, rev, parentHex, instruction, boostFrom) {
	const base = makeAsset(subject, style, rev, parentHex, instruction);
	let q = qualityOf(base.hex);
	if (boostFrom) {
		const hit = boostFrom.issues.some((i) => String(instruction ?? "").toUpperCase().includes(i));
		q = Math.min(95, boostFrom.q + (hit ? 30 : 5));
	}
	return { ...base, project, subject, quality: q, issues: issuesOf(base.hex, q), history: [] };
}

// the seeded world: two projects that already exist (short tasks read them)
function seedWorld() {
	const mk = (pid, name, budget, names) => {
		S.projects[pid] = { id: pid, name, budget, state: "open" };
		for (const n of names) {
			const sid = nextId("s", "s");
			S.subjects[sid] = { id: sid, project: pid, name: n, kind: "character" };
			const aid = nextId("a", "a");
			S.assets[aid] = newAsset(pid, sid, "baseline", 0);
			ledger(pid, "settle", COST.generate, `seed:${aid}`);
		}
	};
	mk("p_1", "Harbor", 300, ["Captain Ilse", "Net Mender", "Lighthouse Keeper"]);
	mk("p_2", "Lantern", 500, ["Paper Moth", "Glass Fox", "Ember Child", "Salt Crow", "Moss Giant", "Tin Heron", "Clock Mouse", "Rain Owl"]);
}

// ── padding tools: working CRUD in other domains ─────────────────────────
const DOMAINS = [
	["calendar", "event", ["title", "start", "end", "attendees"]], ["notes", "note", ["title", "body", "tags"]],
	["tickets", "ticket", ["title", "severity", "assignee", "status"]], ["billing", "invoice", ["customer", "amount", "currency", "status"]],
	["stock", "stock_item", ["name", "quantity", "location"]], ["contacts", "contact", ["name", "email", "organisation"]],
	["files", "file", ["name", "folder", "size_kb"]], ["metrics", "metric", ["name", "value", "unit"]],
	["reminders", "reminder", ["text", "due", "channel"]], ["teams", "member", ["name", "role", "timezone"]],
	["documents", "document", ["title", "owner", "revision"]], ["labels", "label", ["name", "colour", "scope"]],
	["shipments", "shipment", ["carrier", "destination", "weight_kg"]], ["surveys", "survey", ["question", "audience", "responses"]],
];
const OPS = ["create", "get", "list", "update", "search", "delete", "archive", "summarize"];
function paddingTools() {
	const out = [];
	for (const [dom, noun, fields] of DOMAINS) for (const op of OPS) {
		const props = { id: { type: "string", description: `Identifier of the ${noun}.` } };
		for (const f of fields) props[f] = { type: "string", description: `The ${f} of the ${noun}. Free text; stored as given and returned unchanged by later reads.` };
		props.limit = { type: "integer", description: "Maximum number of records to return (default 20)." };
		props.cursor = { type: "string", description: "Opaque pagination cursor from a previous response." };
		const needs = op === "create" ? fields.slice(0, 2) : ["get", "update", "delete", "archive"].includes(op) ? ["id"] : [];
		out.push({
			name: `${dom}_${op}`,
			description: `${op[0].toUpperCase()}${op.slice(1)} ${noun} records in the ${dom} service. Operates on the shared workspace store; every record keeps its creation order and an archived flag. Returns a JSON object. Use the ${dom}_list and ${dom}_search tools to discover identifiers before calling ${dom}_get, ${dom}_update, ${dom}_archive or ${dom}_delete. This tool belongs to the ${dom} service and has no effect on studio projects or credits.`,
			inputSchema: { type: "object", properties: props, required: needs },
			pad: { dom, noun, fields, op },
		});
	}
	return out;
}
function padStore(dom) {
	if (!S.pad[dom]) S.pad[dom] = Array.from({ length: 10 }, (_, i) => ({ id: `${dom}_${i + 1}`, archived: false, ...Object.fromEntries((DOMAINS.find((d) => d[0] === dom)[2]).map((f) => [f, `${f}-${num(h("pad", dom, String(i), f), 0, 4)}`])) }));
	return S.pad[dom];
}
function runPadding(def, a) {
	const { dom, fields, op } = def.pad;
	const rows = padStore(dom);
	const find = () => rows.find((r) => r.id === a.id);
	if (op === "list") return { items: rows.filter((r) => !r.archived).slice(0, a.limit ?? 20), total: rows.length };
	if (op === "search") return { items: rows.filter((r) => Object.values(r).some((v) => String(v).includes(a.query ?? a[fields[0]] ?? ""))).slice(0, a.limit ?? 20) };
	if (op === "summarize") return { total: rows.length, archived: rows.filter((r) => r.archived).length };
	if (op === "create") { const r = { id: `${dom}_${rows.length + 1}`, archived: false, ...Object.fromEntries(fields.map((f) => [f, a[f] ?? ""])) }; rows.push(r); return r; }
	const r = find(); if (!r) throw new Err("not_found", `no ${dom} record ${a.id}`);
	if (op === "get") return r;
	if (op === "update") { for (const f of fields) if (a[f] !== undefined) r[f] = a[f]; return r; }
	if (op === "archive") { r.archived = true; return r; }
	if (op === "delete") { rows.splice(rows.indexOf(r), 1); return { deleted: a.id }; }
	return r;
}

// ── studio tools ─────────────────────────────────────────────────────────
class Err extends Error { constructor(code, message) { super(message); this.code = code; } }
const str = (d) => ({ type: "string", description: d });
const studio = [
	["create_project", "Create a studio project with a credit budget. Returns the project id. Credits are spent by generate_asset, analyze_asset, revise_asset and finalize_project; spending beyond the budget is refused.",
		{ name: str("Project name."), budget_credits: { type: "integer", description: "Total credits the project may spend." } }, ["name", "budget_credits"],
		(a) => { const p = { id: nextId("p", "p"), name: a.name, budget: a.budget_credits, state: "open" }; S.projects[p.id] = p; return { project_id: p.id, receipt: `r_${S.next.r++}` }; }, true],
	["add_subject", "Add a subject (a character, prop or place that needs artwork) to an open project. Returns the subject id.",
		{ project_id: str("Project id."), name: str("Subject name."), kind: { type: "string", enum: ["character", "prop", "place"], description: "Subject kind." } }, ["project_id", "name"],
		(a) => { const p = open(a.project_id); const s = { id: nextId("s", "s"), project: p.id, name: a.name, kind: a.kind ?? "character" }; S.subjects[s.id] = s; return { subject_id: s.id, receipt: `r_${S.next.r++}` }; }, true],
	["list_subjects", "List the subjects of a project with their asset counts.", { project_id: str("Project id.") }, ["project_id"],
		(a) => { const p = exists(a.project_id); return { project_id: p.id, subjects: Object.values(S.subjects).filter((s) => s.project === p.id).map((s) => ({ id: s.id, name: s.name, kind: s.kind, assets: Object.values(S.assets).filter((x) => x.subject === s.id).length })) }; }, false],
	["get_subject", "Get one subject and the ids of its assets.", { subject_id: str("Subject id.") }, ["subject_id"],
		(a) => { const s = S.subjects[a.subject_id]; if (!s) throw new Err("not_found", `no subject ${a.subject_id}`); return { ...s, asset_ids: Object.entries(S.assets).filter(([, x]) => x.subject === s.id).map(([id]) => id) }; }, false],
	["generate_asset", "Generate one artwork asset for a subject in a style. Costs 5 credits (reserved, then settled). Pass call_id to make a retry safe: a repeated call_id returns the first result and charges nothing. The asset is not guaranteed to be good: run analyze_asset and revise_asset until it passes.",
		{ subject_id: str("Subject id."), style: str("Style name, e.g. noir."), call_id: str("Idempotency key.") }, ["subject_id", "style"],
		(a) => { const s = S.subjects[a.subject_id]; if (!s) throw new Err("not_found", `no subject ${a.subject_id}`); const p = open(s.project); charge(p, COST.generate, "generate"); const id = nextId("a", "a"); S.assets[id] = newAsset(p.id, s.id, a.style, 0); return { ...assetView(id, false), receipt: `r_${S.next.r++}`, credits_spent: COST.generate }; }, true],
	["analyze_asset", "Inspect an asset. Costs 1 credit. Returns the quality score, whether it passes (score at least 70) and, when it does not, the issue codes to fix. Pass the issue codes to revise_asset.",
		{ asset_id: str("Asset id.") }, ["asset_id"],
		(a) => { const x = asset(a.asset_id); charge(open(x.project), COST.analyze, "analyze"); return { asset_id: a.asset_id, revision: x.rev, score: x.quality, passes: x.quality >= PASS_AT, issues: x.issues }; }, true],
	["revise_asset", "Create a new revision of an asset from an instruction. Costs 3 credits. The instruction must name the issue codes returned by analyze_asset (for example LIGHT_FLAT) to fix them; a vague instruction barely helps. Pass call_id for safe retries.",
		{ asset_id: str("Asset id."), instruction: str("What to change; name the issue codes."), call_id: str("Idempotency key.") }, ["asset_id", "instruction"],
		(a) => { const x = asset(a.asset_id); const p = open(x.project); charge(p, COST.revise, "revise"); const y = newAsset(x.project, x.subject, x.style, x.rev + 1, x.hex, a.instruction, { q: x.quality, issues: x.issues }); y.history = [...x.history, { rev: x.rev, score: x.quality }]; S.assets[a.asset_id] = y; return { ...assetView(a.asset_id, false), receipt: `r_${S.next.r++}`, credits_spent: COST.revise }; }, true],
	["list_assets", "List the assets of a project, optionally for one subject or only those needing revision. Returns full records unless compact is true.",
		{ project_id: str("Project id."), subject_id: str("Only this subject."), needs_revision: { type: "boolean", description: "Only assets below the passing score." }, compact: { type: "boolean", description: "Return id, subject, status and revision only." } }, ["project_id"],
		(a) => { exists(a.project_id); let ids = Object.keys(S.assets).filter((id) => S.assets[id].project === a.project_id); if (a.subject_id) ids = ids.filter((id) => S.assets[id].subject === a.subject_id); if (a.needs_revision) ids = ids.filter((id) => S.assets[id].quality < PASS_AT); return { project_id: a.project_id, assets: ids.map((id) => { const v = assetView(id, false); return a.compact ? { asset_id: v.asset_id, subject_id: v.subject_id, status: v.status, revision: v.revision } : v; }) }; }, false],
	["get_asset", "Get one asset with its full record (revision history and render log).", { asset_id: str("Asset id.") }, ["asset_id"],
		(a) => { asset(a.asset_id); return assetView(a.asset_id, true); }, false],
	["arrange_board", "Arrange assets on the project board. Refused while any listed asset is below the passing score. Returns the board id.",
		{ project_id: str("Project id."), asset_ids: { type: "array", items: { type: "string" }, description: "Assets to place." }, layout: { type: "string", enum: ["grid", "strip"], description: "Layout." } }, ["project_id", "asset_ids"],
		(a) => { const p = open(a.project_id); const low = a.asset_ids.filter((id) => !S.assets[id] || S.assets[id].quality < PASS_AT); if (low.length) throw new Err("asset_below_threshold", `not passing or unknown: ${low.map((id) => `${id}(${S.assets[id]?.quality ?? "?"})`).join(", ")}`); const b = { id: `b_${p.id}`, assets: a.asset_ids, layout: a.layout ?? "grid" }; S.boards[p.id] = b; return { board_id: b.id, placed: a.asset_ids.length, receipt: `r_${S.next.r++}` }; }, true],
	["request_approval", "Ask for approval to close the project. Requires an arranged board and spending within budget. Returns the approval token that finalize_project needs.",
		{ project_id: str("Project id."), summary: str("What is being approved.") }, ["project_id"],
		(a) => { const p = open(a.project_id); if (!S.boards[p.id]) throw new Err("no_board", "arrange a board first"); const token = `ap_${h("approval", p.id).slice(0, 8)}`; S.approvals[p.id] = token; return { approval_token: token, spent: spent(p.id), budget: p.budget }; }, true],
	["finalize_project", "Close the project. Costs 10 credits. Requires the approval token from request_approval.",
		{ project_id: str("Project id."), approval_token: str("Token from request_approval.") }, ["project_id", "approval_token"],
		(a) => { const p = open(a.project_id); if (S.approvals[p.id] !== a.approval_token) throw new Err("not_approved", "missing or wrong approval token"); charge(p, COST.finalize, "finalize"); p.state = "final"; return { project_id: p.id, state: "final", receipt: `r_${S.next.r++}` }; }, true],
	["wallet_balance", "Credits spent and remaining for a project.", { project_id: str("Project id.") }, ["project_id"],
		(a) => { const p = exists(a.project_id); return { project_id: p.id, budget: p.budget, spent: spent(p.id), remaining: p.budget - spent(p.id) }; }, false],
].map(([name, description, properties, required, run, mutates]) => ({ name, description, inputSchema: { type: "object", properties, required }, run, mutates }));

function exists(id) { const p = S.projects[id]; if (!p) throw new Err("not_found", `no project ${id}`); return p; }
function open(id) { const p = exists(id); if (p.state !== "open") throw new Err("project_closed", `project ${id} is ${p.state}`); return p; }
function asset(id) { const x = S.assets[id]; if (!x) throw new Err("not_found", `no asset ${id}`); return x; }
function charge(p, amount, ref) {
	if (spent(p.id) + amount > p.budget) throw new Err("insufficient_credits", `${ref} costs ${amount}, remaining ${p.budget - spent(p.id)}`);
	ledger(p.id, "reserve", amount, ref); ledger(p.id, "settle", amount, ref);
}

const ALL = [...studio, ...paddingTools()];
const OFFERED = ALL.slice(0, NTOOLS);
const BY = new Map(OFFERED.map((t) => [t.name, t]));

function snapshot() {
	if (!SNAPSHOT) return;
	const body = { seed: SEED, tools: NTOOLS, volume: VOLUME, projects: S.projects, subjects: S.subjects, assets: Object.fromEntries(Object.entries(S.assets).map(([id, a]) => [id, { project: a.project, subject: a.subject, style: a.style, rev: a.rev, quality: a.quality, issues: a.issues }])), boards: S.boards, approvals: S.approvals, ledger: S.ledger, calls: S.calls };
	writeFileSync(`${SNAPSHOT}.tmp`, JSON.stringify(body)); renameSync(`${SNAPSHOT}.tmp`, SNAPSHOT);
}

function callTool(name, args) {
	const t = BY.get(name);
	if (!t) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "unknown_tool", message: `no tool named ${name}` }) }] };
	S.calls[name] = (S.calls[name] ?? 0) + 1;
	const missing = (t.inputSchema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
	if (missing.length) { snapshot(); return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: "invalid_arguments", message: `missing required: ${missing.join(", ")}`, required: t.inputSchema.required }) }] }; }
	try {
		const key = args.call_id ? `${name}:${args.call_id}` : null;
		if (key && S.seen[key]) { snapshot(); return { content: [{ type: "text", text: JSON.stringify({ ...S.seen[key], replayed: true }) }] }; }
		const out = t.pad ? runPadding(t, args) : t.run(args);
		if (key) S.seen[key] = out;
		snapshot();
		return { content: [{ type: "text", text: JSON.stringify(out) }] };
	} catch (e) {
		snapshot();
		if (e instanceof Err) return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: e.code, message: e.message }) }] };
		throw e;
	}
}

seedWorld();
snapshot();
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	if (!line.trim()) return;
	let m; try { m = JSON.parse(line); } catch { return; }
	const reply = (result) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
	const fail = (code, message) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, error: { code, message } });
	switch (m.method) {
		case "initialize": return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "studio-mock", version: "1.0.0" } });
		case "ping": return reply({});
		case "tools/list": return reply({ tools: OFFERED.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
		case "tools/call": {
			toolCalls += 1;
			if (DRIFT_AFTER > 0 && toolCalls > DRIFT_AFTER) { const t = BY.get("add_subject"); if (t && !t.drifted) { t.drifted = true; t.inputSchema = { ...t.inputSchema, properties: { ...t.inputSchema.properties, title: t.inputSchema.properties.name }, required: ["project_id", "title"] }; delete t.inputSchema.properties.name; } }
			const out = callTool(m.params?.name, m.params?.arguments ?? {}); const d = DELAY_AFTER[m.params?.name];
			const send = () => { reply(out); if (EXIT_AFTER > 0 && toolCalls >= EXIT_AFTER) setTimeout(() => process.exit(3), 20); };
			return d || LATENCY ? void setTimeout(send, (d ?? 0) + LATENCY) : send();
		}
		default: return m.method?.startsWith("notifications/") ? undefined : fail(-32601, `method not found: ${m.method}`);
	}
}).on("close", () => { snapshot(); process.exit(0); });
