// One remembered effort for the terminal and the web app (preferences.json): a profile's remembered level is what a new Work
// sends, and a level chosen for one Work in the web is remembered there for the next Work and for the terminal. A local
// endpoint records each request's reasoning_effort.
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("effort-prefs");
const seen = [];
const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const endpoint = createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", () => (seen.push(body === "" ? {} : JSON.parse(body)), res.writeHead(200, { "content-type": "text/event-stream" }), res.end(chunk({ role: "assistant", content: "Ok." }) + chunk({}, "stop") + "data: [DONE]\n\n")));
});
await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${endpoint.address().port}`;
const home = scratch("effort-home");
writeFileSync(join(home, "config.json"), JSON.stringify({ model: "mock", models: { mock: { kind: "openai-compat", model: "mock-1", baseUrl: `${origin}/v1`, apiKeyEnv: "MOCK_ENDPOINT_KEY", effort: { levels: ["low", "high"], default: "high" } } } }));
writeFileSync(join(home, "auth.json"), JSON.stringify({ version: 1, credentials: { [`endpoint:${origin}`]: { type: "api-key", key: "sk-effort-0000", savedAt: 1 } } }));
writeFileSync(join(home, "preferences.json"), JSON.stringify({ effort: { mock: "high" } }));
const env = { ...process.env, KISO_HOME: home };
delete env.MOCK_ENDPOINT_KEY;
const host = await launch({ data: home, workspace: scratch("effort-ws"), env });
const run = async (id) => ((s) => s.run("Reply OK.").then(() => waitUntil(async () => !(await s.state()).running, 15_000)))(clientFor(host).session(id));
const prefs = () => JSON.parse(readFileSync(join(home, "preferences.json"), "utf8")).effort?.mock;

await run("w-one");
check(seen.at(-1)?.reasoning_effort === "high", `the remembered level is what a new Work sends (sent: ${JSON.stringify(seen.at(-1)?.reasoning_effort)})`);
await fetch(`${host.origin}/desk/settings`, { method: "POST", headers: { authorization: `Bearer ${host.token}` }, body: JSON.stringify({ session: "w-one", effort: "low" }) });
check(prefs() === "low", "a level chosen for one Work in the web is remembered in preferences.json, for the terminal too");
await run("w-two");
check(seen.at(-1)?.reasoning_effort === "low", `and the next new Work starts there (sent: ${JSON.stringify(seen.at(-1)?.reasoning_effort)})`);
writeFileSync(join(home, "preferences.json"), JSON.stringify({ effort: { mock: "high" } })); // the terminal chooses again, the host running
await run("w-three");
check(seen.at(-1)?.reasoning_effort === "high", "a level the terminal remembers while the web host runs counts for the next Work");
host.child.kill("SIGKILL");
endpoint.close();
verdict();
