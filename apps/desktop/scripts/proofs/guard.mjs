// Line 2, the guard: what the loopback listener refuses, and what it
// serves. Raw node:http so the Host and Origin headers can be set freely
// (fetch forbids Host). Then the typed client from this separate process.
import { request } from "node:http";
import { launch, clientFor, scratch, transcript } from "./lib.mjs";

const out = transcript("s2-guard");
const data = scratch("s2-data");
const workspace = scratch("s2-ws");
const host = await launch({ data, workspace, fauxScript: [{ events: [{ type: "text_delta", text: "hi" }, { type: "stop", reason: "end_turn" }] }], env: { KISO_DESKTOP_MODE: "full-access" } });
out(`host ${host.origin} (listening on 127.0.0.1 only; port chosen by the system)`);
const port = host.port;

const call = (path, { method = "GET", headers = {}, hostHeader, body } = {}) =>
	new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, method, headers: { ...(hostHeader !== undefined ? { host: hostHeader } : {}), ...headers } }, (res) => {
			let text = "";
			res.on("data", (d) => (text += d));
			res.on("end", () => resolve({ status: res.statusCode, text, type: res.headers["content-type"], csp: res.headers["content-security-policy"] }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
const bearer = { authorization: `Bearer ${host.token}` };
const cases = [
	["page, no credentials", () => call("/"), 200],
	["session snapshot, no token", () => call("/v1/sessions/x/state"), 401],
	["session snapshot, wrong token", () => call("/v1/sessions/x/state", { headers: { authorization: "Bearer nope" } }), 401],
	["session snapshot, right token", () => call("/v1/sessions/x/state", { headers: bearer }), 200],
	["right token, foreign Origin", () => call("/v1/sessions/x/state", { headers: { ...bearer, origin: "https://evil.example" } }), 403],
	["right token, Origin: null (sandboxed frame)", () => call("/v1/sessions/x/state", { headers: { ...bearer, origin: "null" } }), 403],
	["right token, own Origin", () => call("/v1/sessions/x/state", { headers: { ...bearer, origin: host.origin } }), 200],
	["rebinding: Host names another domain", () => call("/v1/sessions/x/state", { headers: bearer, hostHeader: `attacker.example:${port}` }), 403],
	["page, rebinding Host", () => call("/", { hostHeader: `attacker.example:${port}` }), 403],
	["CORS preflight from a foreign origin", () => call("/v1/sessions/x/run", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }), 403],
	["POST run, no token", () => call("/v1/sessions/x/run", { method: "POST", headers: { "content-type": "application/json" }, body: '{"input":"hi"}' }), 401],
	["unknown path", () => call("/etc/passwd"), 404],
	["vendor path traversal", () => call("/vendor/client/..%2f..%2fpackage.json"), 404],
];
let pass = true;
for (const [label, fn, want] of cases) {
	const r = await fn();
	const ok = r.status === want;
	pass &&= ok;
	out(`${ok ? "ok  " : "FAIL"} ${String(r.status).padEnd(3)} (want ${want}) ${label}${label === "page, no credentials" ? `  [CSP: ${r.csp?.slice(0, 40)}…]` : ""}`);
}

// the typed client from this separate process: run, then the stream
const s = clientFor(host).session("guard");
const seen = [];
for await (const ev of s.runStream("hello")) if (ev.kind === "event") seen.push(ev.event.type);
out(`kiso-client from a separate Node process: ${seen.join(" ")}`);
const page = await call("/");
out(`page served by the same process: ${page.status} ${page.type}, ${page.text.length} bytes, imports the client from /vendor/client/index.js: ${(await call("/vendor/client/index.js")).status === 200}`);
out(`RESULT guard: ${pass ? "PASS" : "FAIL"}`);
if (!pass) process.exitCode = 1;
host.child.kill("SIGTERM");
