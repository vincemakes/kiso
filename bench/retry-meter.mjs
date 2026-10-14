#!/usr/bin/env node
/**
 * retry-meter.mjs — a local metering proxy that absorbs a provider's
 * spurious 400s (route `cr` in route.sh: `co` behind this proxy).
 *
 *   node bench/retry-meter.mjs --port 47630 --upstream https://api.commandcode.ai/provider/v1 \
 *        --cred-file ~/.config/kiso-commandcode/credentials.env --cred-key COMMANDCODE_API_KEY \
 *        --out <dir> --cap-usd 3
 *
 * WHY THE RETRY. On 2026-10-14 the `co` route answered `400
 * invalid_request_error` (a trace id, no explanation) to about 3% of
 * requests for hours. kiso ends a run on a 400, so a long trial rarely
 * finished clean and a paired round was contaminated on both arms. The
 * refused bodies, re-sent byte for byte, returned 200 nine times in nine,
 * and eight concurrent requests gave 24/24, so the refusal is not a
 * property of the request. This proxy re-sends a 400 up to RETRY_400
 * attempts in all before the client sees anything; each refused attempt
 * is its own ledger line (`retried: true`, no usage); the last answer,
 * whatever it is, goes to the client. The same for every arm.
 *
 * THE METER IT EXTENDS (the Terminal-Bench harness's).
 *  1. The real key never enters a container. LB-2 (the launch bench) found an
 *     inherited key printed into a transcript by an arm's own shell tool; a
 *     container's agent has a shell. The container gets a URL and a dummy key.
 *  2. ONE meter for both arms: every request's usage is read from the
 *     provider's own response, whatever the arm's trace format is.
 *  3. The spend cap lives here: past it, every request is refused with 503 and
 *     STOPPED is written, so no arm can spend past the cap.
 *
 * A request path is /t/<tag>/<rest>; <tag> names the trial (arm, task,
 * attempt). It is stripped before forwarding. One JSON line per request goes
 * to <out>/requests.jsonl. The key is read from the file at start, held in
 * memory, and never written, logged or echoed.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RETRY_400 = 3; // attempts in all for a provider 400 (the header: WHY THE RETRY)
export const RATES = { input: 0.15, cacheRead: 0.003, output: 0.6 }; // $/M, bench/round-spend.mjs

/** Provider usage -> { prompt, cached, out, reasoning }. prompt INCLUDES the cache hit (DeepSeek convention). */
export function normalizeUsage(u) {
	if (!u || typeof u !== "object") return null;
	if ((u.prompt_tokens ?? u.input_tokens) === undefined || (u.completion_tokens ?? u.output_tokens) === undefined) return null;
	const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? 0);
	const cached = Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0);
	const out = Number(u.completion_tokens ?? u.output_tokens ?? 0);
	const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? 0);
	if (![prompt, cached, out, reasoning].every((n) => Number.isFinite(n) && n >= 0) || cached > prompt || reasoning > out) return null;
	return { prompt, cached, out, reasoning };
}

export function costUsd(n) {
	return (((n.prompt - n.cached) * RATES.input) + n.cached * RATES.cacheRead + n.out * RATES.output) / 1e6;
}

/** Find the usage object in a response body: one JSON document, or SSE `data:` lines (the last usage wins). */
export function usageFromBody(text) {
	let last = null;
	const trimmed = text.trimStart();
	if (trimmed.startsWith("{")) {
		try { return normalizeUsage(JSON.parse(trimmed).usage); } catch { /* fall through to lines */ }
	}
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const d = line.slice(5).trim();
		if (d === "" || d === "[DONE]" || !d.includes("usage")) continue;
		try { const u = normalizeUsage(JSON.parse(d).usage); if (u) last = u; } catch { /* partial line */ }
	}
	return last;
}

export function parseTarget(url) {
	const m = /^\/t\/([A-Za-z0-9][A-Za-z0-9._-]{0,119})(\/.*)?$/.exec(url);
	return m && !(m[2] ?? "").includes("..") ? { tag: m[1], rest: m[2] ?? "/" } : null;
}

export function readKey(file, name) {
	const text = fs.readFileSync(file, "utf8");
	const m = new RegExp(`^(?:export\\s+)?${name}=(.*)$`, "m").exec(text);
	if (!m) throw new Error(`the credentials file carries no ${name}`);
	return m[1].trim().replace(/^['"]|['"]$/g, "");
}

export function createProxy({ upstream, key, out, capUsd, token = null, log = () => {}, observe = () => {} }) {
	const base = new URL(upstream);
	const client = base.protocol === "https:" ? https : http;
	fs.mkdirSync(out, { recursive: true });
	const reqLog = path.join(out, "requests.jsonl");
	let observerErrors = 0;
	let spent = 0;
	let stopped = fs.existsSync(path.join(out, "STOPPED"));
	const server = http.createServer((req, res) => {
		const target = parseTarget(req.url ?? "");
		// a run token: the proxy spends the owner's key, so only this run's containers may use it
		if (token !== null && req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); res.end("bad token"); return; }
		if (!target) { res.writeHead(404); res.end("no trial tag"); return; }
		if (stopped || spent >= capUsd) {
			if (!stopped) { stopped = true; fs.writeFileSync(path.join(out, "STOPPED"), `spend cap ${capUsd} reached: ${spent.toFixed(4)} at ${new Date().toISOString()}\n`); }
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "spend cap reached", type: "spend_cap" } }));
			return;
		}
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const t0 = Date.now();
			const emit = (event, details = {}, socket = null) => {
				try { observe({ event, tag: target.tag, atMs: Date.now(), ...details }, socket); } catch { observerErrors += 1; }
			};
			emit("upstream_start", { bodyBytes: body.length, bodySha256: createHash("sha256").update(body).digest("hex") });
			const headers = { ...req.headers, host: base.host, authorization: `Bearer ${key}`, "content-length": String(body.length) };
			delete headers["x-api-key"];
			let settled = false;
			let responseStatus = 502;
			const parts = [];
			const record = (status, error = null) => {
				if (settled) return;
				settled = true;
				const usage = usageFromBody(Buffer.concat(parts).toString("utf8"));
				if (usage) spent += costUsd(usage);
				fs.appendFileSync(reqLog, JSON.stringify({ ts: new Date(t0).toISOString(), tag: target.tag, path: target.rest,
					status, ms: Date.now() - t0, usage, spentTotal: Number(spent.toFixed(6)), ...(error ? { error } : {}) }) + "\n");
			};
			// WHY THE RETRY (the header): a provider 400 is re-sent byte for byte, up to
			// RETRY_400 attempts in all, before kiso sees anything. Each refused
			// attempt is its own ledger line (retried: true); the last answer,
			// whatever it is, goes to the client.
			const send = (attempt) => {
			const up = client.request({ protocol: base.protocol, hostname: base.hostname, port: base.port || undefined, method: req.method, path: base.pathname.replace(/\/$/, "") + target.rest, headers }, (ur) => {
				responseStatus = ur.statusCode ?? 502;
				emit("response_headers", { status: responseStatus, attempt });
				if (responseStatus === 400 && attempt < RETRY_400) {
					const refused = [];
					ur.on("data", (c) => refused.push(c));
					ur.on("end", () => {
						fs.appendFileSync(reqLog, JSON.stringify({ ts: new Date(t0).toISOString(), tag: target.tag, path: target.rest,
							status: 400, ms: Date.now() - t0, usage: null, spentTotal: Number(spent.toFixed(6)), retried: true, attempt,
							note: Buffer.concat(refused).toString("utf8").slice(0, 200) }) + "\n");
						setTimeout(() => send(attempt + 1), 500);
					});
					return;
				}
				res.writeHead(responseStatus, ur.headers);
				ur.on("data", (c) => { parts.push(c); res.write(c); });
				ur.on("end", () => {
					if (settled) return;
					res.end(); record(responseStatus); emit("upstream_end", { status: responseStatus });
				});
				ur.on("aborted", () => {
					if (settled) return;
					emit("upstream_aborted", { status: responseStatus });
					record(responseStatus, "UPSTREAM_ABORTED"); res.destroy();
				});
				ur.on("error", (e) => {
					if (settled) return;
					emit("upstream_response_error", { status: responseStatus, code: String(e.code ?? e.message) });
					record(responseStatus, String(e.code ?? e.message)); res.destroy();
				});
			});
			up.on("finish", () => emit("request_sent"));
			up.on("socket", (socket) => emit("socket_assigned", { reusedSocket: !!up.reusedSocket }, socket));
			up.on("error", (e) => {
					if (settled) return;
				emit("upstream_error", { code: String(e.code ?? e.message) }); log(`upstream error: ${e.code ?? e.message}`);
				if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
				record(responseStatus, String(e.code ?? e.message));
			});
			up.end(body);
			};
			send(1);
		});
	});
	return { server, spent: () => spent, observerErrors: () => observerErrors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = Object.fromEntries(process.argv.slice(2).reduce((a, v, i, all) => (v.startsWith("--") ? [...a, [v.slice(2), all[i + 1]]] : a), []));
	for (const k of ["port", "upstream", "cred-file", "cred-key", "out", "cap-usd"]) if (!args[k]) { console.error(`meter-proxy: --${k} is required`); process.exit(2); }
	const key = readKey(args["cred-file"].replace(/^~/, process.env.HOME ?? ""), args["cred-key"]);
	const { server } = createProxy({ upstream: args.upstream, key, out: args.out, capUsd: Number(args["cap-usd"]), token: args.token ?? null, log: (m) => console.error(m) });
	// 127.0.0.1: Docker Desktop's host.docker.internal reaches a host loopback listener; the LAN never sees the proxy
	server.listen(Number(args.port), args.bind ?? "127.0.0.1", () => console.error(`meter-proxy up on :${args.port} -> ${new URL(args.upstream).host} (cap $${args["cap-usd"]})`));
}
