#!/usr/bin/env node
/**
 * extract.mjs <leg dir> <snapshot.json> — one JSON object with the metrics of
 * one leg of either arm family, from the arm's own durable session record plus
 * the server's snapshot (the arm-independent ground truth of what was called).
 *
 * ACCOUNTING (one definition for both families): cw = fresh input + 0.1 x
 * cache-read. The reference arm reports fresh-only input; kiso's inputTokens
 * INCLUDES the cache-hit prefix, so fresh = input - cacheRead there.
 *
 * Reported per leg: requests, cw, output tokens, wall; model-issued tool calls
 * by name; script-tool calls and the nested calls they made; the server's own
 * call counters (calls the model never issued itself show up here and not in
 * the session); characters of tool results that entered the context; the
 * first request's tool table and the capture's first/last body bytes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { readCapture } from "../reconcile-capture.mjs";

const [leg, snapPath] = process.argv.slice(2);
if (!leg) { console.error("usage: extract.mjs <leg dir> <snapshot.json>"); process.exit(2); }
const family = basename(leg).startsWith("kiso-") ? "kiso" : "pi";
const m = { family, requests: 0, unknownUsage: 0, fresh: 0, cacheRead: 0, output: 0, toolCalls: {}, codemodeCalls: 0, toolSearchCalls: 0, nestedCalls: 0, resultChars: 0, resultCharsByTool: {} };
const findKey = (o, k) => { if (o && typeof o === "object") { if (k in o) return o[k]; for (const v of Object.values(o)) { const r = findKey(v, k); if (r !== undefined) return r; } } return undefined; };
const note = (name) => { m.toolCalls[name] = (m.toolCalls[name] ?? 0) + 1; if (name === "codemode" || name === "program" || name === "plan") m.codemodeCalls += 1; if (name === "tool_search") m.toolSearchCalls += 1; };
const addResult = (name, chars) => { m.resultChars += chars; m.resultCharsByTool[name] = (m.resultCharsByTool[name] ?? 0) + chars; };

if (family === "pi") {
	const file = join(leg, "pi-session");
	for (const l of existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []) {
		let e; try { e = JSON.parse(l); } catch { continue; }
		const msg = e.type === "message" ? e.message : null; if (!msg) continue;
		if (msg.role === "assistant") {
			const u = msg.usage; m.requests += 1;
			if (!u || typeof u.input !== "number" || typeof u.cacheRead !== "number" || typeof u.output !== "number") m.unknownUsage += 1;
			else { m.fresh += u.input; m.cacheRead += u.cacheRead; m.output += u.output; }
			for (const b of msg.content ?? []) if (b.type === "toolCall") note(b.name);
		} else if (msg.role === "toolResult") {
			addResult(msg.toolName, (msg.content ?? []).reduce((s, b) => s + (typeof b.text === "string" ? b.text.length : 0), 0));
			const nested = findKey(msg, "nestedCalls"); if (nested && Array.isArray(nested.calls)) m.nestedCalls += nested.calls.length;
		}
	}
} else {
	const dir = join(leg, "kiso-home", "sessions");
	const f = existsSync(dir) ? readdirSync(dir).find((x) => x.endsWith(".jsonl") && !x.includes("trace") && !x.startsWith("sub-")) : null;
	const names = {};
	for (const l of f ? readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean) : []) {
		let e; try { e = JSON.parse(l); } catch { continue; } e = e.event ?? e;
		if (e.type === "usage") {
			m.requests += 1;
			if (e.known === false || typeof e.inputTokens !== "number" || typeof e.cacheRead !== "number" || typeof e.outputTokens !== "number") m.unknownUsage += 1;
			else { m.fresh += e.inputTokens - e.cacheRead; m.cacheRead += e.cacheRead; m.output += e.outputTokens; }
		} else if (e.type === "tool_call_end") { names[e.callId] = e.name; note(e.name); }
		else if (e.type === "tool_execution_started" && String(e.callId).includes("/")) m.nestedCalls += 1; // a child call of a program
		else if (e.type === "tool_result") addResult(names[e.callId] ?? "?", typeof e.content === "string" ? e.content.length : JSON.stringify(e.content ?? "").length);
	}
}
m.cw = Math.round(m.fresh + 0.1 * m.cacheRead);
m.wallSeconds = ["wall_1", "wall_2", "wall_3", "wall_4"].reduce((s, n) => s + (existsSync(join(leg, n)) ? Number(readFileSync(join(leg, n), "utf8")) || 0 : 0), 0);
if (snapPath && existsSync(snapPath)) {
	const s = JSON.parse(readFileSync(snapPath, "utf8"));
	m.serverCalls = s.calls; m.serverCallsTotal = Object.values(s.calls).reduce((a, b) => a + b, 0);
	m.creditsSpent = s.ledger.filter((x) => x.kind === "settle").reduce((a, b) => a + b.amount, 0);
}
try {
	const recs = readCapture(join(leg, "capture")).filter((r) => r.body?.tools);
	if (recs.length) { m.toolTable = (recs[0].body.tools ?? []).map((t) => t.function?.name ?? t.name).sort(); m.toolTableBytes = JSON.stringify(recs[0].body.tools).length; }
} catch { /* no capture */ }
try { const c = JSON.parse(readFileSync(join(leg, "capture.json"), "utf8")); m.bytesFirst = c.bytesFirst; m.bytesLast = c.bytesLast; m.captureOk = c.ok; } catch { /* none */ }
console.log(JSON.stringify(m));
