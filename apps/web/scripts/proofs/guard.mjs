// What the loopback listener refuses and what it serves. Raw node:http so Host and Origin can be set freely.
import { request } from "node:http";
import { launch, clientFor, scratch, checker } from "./lib.mjs";

const { check, verdict } = checker("guard");
const host = await launch({ data: scratch("guard-data"), workspace: scratch("guard-ws"), fauxScript: [{ events: [{ type: "text_delta", text: "hi" }, { type: "stop", reason: "end_turn" }] }], env: { KISO_WEB_MODE: "full-access" } });
const call = (path, { method = "GET", headers = {}, hostHeader, body } = {}) =>
	new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: host.port, path, method, headers: { ...(hostHeader && { host: hostHeader }), ...headers } }, (res) => {
			let text = "";
			res.on("data", (d) => (text += d)).on("end", () => resolve({ status: res.statusCode, text, type: res.headers["content-type"], csp: res.headers["content-security-policy"] }));
		});
		req.on("error", reject).end(body);
	});
const bearer = { authorization: `Bearer ${host.token}` };
const state = "/v1/sessions/x/state";
const cases = [
	["the page needs no credentials", () => call("/"), 200],
	["no token", () => call(state), 401],
	["wrong token", () => call(state, { headers: { authorization: "Bearer nope" } }), 401],
	["right token", () => call(state, { headers: bearer }), 200],
	["right token, foreign Origin", () => call(state, { headers: { ...bearer, origin: "https://evil.example" } }), 403],
	["right token, Origin null", () => call(state, { headers: { ...bearer, origin: "null" } }), 403],
	["right token, own Origin", () => call(state, { headers: { ...bearer, origin: host.origin } }), 200],
	["rebinding: Host names another domain", () => call(state, { headers: bearer, hostHeader: `attacker.example:${host.port}` }), 403],
	["page with a rebinding Host", () => call("/", { hostHeader: `attacker.example:${host.port}` }), 403],
	["preflight from a foreign origin", () => call("/v1/sessions/x/run", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), 403],
	["POST run without a token", () => call("/v1/sessions/x/run", { method: "POST", body: '{"input":"hi"}' }), 401],
	["static path traversal", () => call("/assets/..%2f..%2f..%2fpackage.json"), 404],
	["a file type the host does not serve", () => call("/index.json"), 404],
	["POST to a static path", () => call("/", { method: "POST" }), 405],
];
for (const [label, fn, want] of cases) check((await fn()).status === want, `${want} ${label}`);
const types = [];
for await (const ev of clientFor(host).session("guard").runStream("hello")) if (ev.kind === "event") types.push(ev.event.type);
check(types.join(" ") === "user_input text_delta terminal", `kiso-client from another process: ${types.join(" ")}`);
const page = await call("/");
const bundle = /src="([^"]+\.js)"/.exec(page.text)?.[1];
check(page.type.startsWith("text/html") && /default-src 'none'/.test(page.csp) && bundle !== undefined && (await call(bundle)).status === 200, "the page and its bundle are served under a content security policy");
host.child.kill("SIGTERM");
verdict();
