// One login for the terminal and the desktop: a profile and a stored key in a temporary KISO_HOME, no key in the environment,
// a local endpoint that records what it is sent. Settings answers without the key and changes the tier and the profile.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("settings");
const seen = [];
const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
const endpoint = createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => {
		seen.push({ url: req.url, auth: req.headers.authorization, body: body === "" ? null : JSON.parse(body) });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(chunk({ role: "assistant", content: "Hello from the endpoint." }) + chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 }) + "data: [DONE]\n\n");
	});
});
await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${endpoint.address().port}`;
const home = scratch("settings-home");
mkdirSync(home, { recursive: true });
const profile = { kind: "openai-compat", model: "mock-1", baseUrl: `${origin}/v1`, apiKeyEnv: "MOCK_ENDPOINT_KEY" };
writeFileSync(join(home, "config.json"), JSON.stringify({ model: "mock", models: { mock: { ...profile, contextWindow: 6000 }, known: { ...profile, model: "gpt-5.5" }, nokey: { ...profile, baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "ABSENT_KEY_NAME" } } }));
writeFileSync(join(home, "auth.json"), JSON.stringify({ version: 1, credentials: { [`endpoint:${origin}`]: { type: "api-key", key: "sk-shared-login-0000", savedAt: 1 } } }));
const env = { ...process.env };
delete env.MOCK_ENDPOINT_KEY;
const host = await launch({ data: home, workspace: scratch("settings-ws"), env: { ...env, KISO_HOME: home, KISO_DESKTOP_MODE: "default" } });
const api = (body) => fetch(`${host.origin}/desk/settings`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${host.token}` }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.text());
let text = await api();
let s = JSON.parse(text);
check(s.profile === "mock" && s.profiles.length === 3 && s.signIn.ok && /stored by the terminal/.test(s.signIn.text) && !text.includes("sk-shared-login-0000"), "Settings names the shared profile and says where the sign-in comes from, without the key");
check(s.profiles.find((p) => p.name === "nokey")?.available === false, "a profile with no sign-in is marked unavailable");
const c = clientFor(host).session("login");
const wire = [];
const frames = [];
const ctl = new AbortController();
const reader = (async () => {
	for await (const ev of c.events({ signal: ctl.signal })) ev.kind === "event" ? wire.push(ev.event) : frames.push(ev);
})();
await c.run("say hello");
await waitUntil(async () => !(await c.state()).running, 10_000);
check(seen.length > 0 && seen.every((r) => r.auth === "Bearer sk-shared-login-0000"), "a run sends the stored key, with none in the environment");
check(wire.some((e) => e.type === "text_delta" && e.text.includes("Hello from the endpoint.")) && !JSON.stringify(wire).includes("sk-shared-login-0000"), "the answer arrives and the key is nowhere on the stream");
check(frames.some((f) => f.event === "usage" && f.data.window === 6000), "the usage frame carries the window the profile states, for the rail's ring");
const big = clientFor(host).session("big");
for (let i = 0; i < 4; i++) {
	await big.run(`part ${i} ${"lorem ipsum dolor sit amet ".repeat(500)}`);
	await waitUntil(async () => !(await big.state()).running, 20_000);
}
check(seen.some((r) => JSON.stringify(r.body).includes("Only output the summary")), "a long Work is compacted by the in-run tiers drawn from the profile's window, as in the terminal");
s = JSON.parse(await api({ mode: "plan", profile: "no-such-profile" }));
check(s.mode === "plan" && s.profile === "mock" && JSON.parse(readFileSync(join(home, "desktop.json"), "utf8")).mode === "plan", "the tier changes and is remembered; an unknown profile is ignored");
await api({ profile: "known" });
let registryWindow;
for await (const ev of clientFor(host).session("known").runStream("hi")) if (ev.kind === "frame" && ev.event === "usage") registryWindow = ev.data.window;
check(registryWindow === 272_000, "a profile that states no window gets the registry's for its model (the smallest it states for it), so the ring can show a percentage");
s = JSON.parse(await api({ profile: "nokey" }));
check(s.profile === "nokey" && !s.signIn.ok && /ABSENT_KEY_NAME/.test(s.signIn.text), "choosing a profile with no sign-in says why it cannot run");
ctl.abort();
await reader;
host.child.kill("SIGTERM");
endpoint.close();
verdict();
