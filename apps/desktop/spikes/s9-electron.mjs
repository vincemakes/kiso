// Line 9: the Electron main starts the host and loads the renderer page,
// which streams a run through kiso-client. Proof two ways: the page's
// console, forwarded to stdout by the main (RENDERER lines), and the remote
// debugging port, where this script evaluates the page's own state.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { scratch, transcript, sleep } from "./lib.mjs";

const out = transcript("s9-electron");
const require = createRequire(import.meta.url);
const electronCli = require.resolve("electron/cli.js");
const appDir = fileURLToPath(new URL("..", import.meta.url));
const data = scratch("s9-data");
const workspace = scratch("s9-ws");
const think = (text) => ({ type: "thinking", text });
const script = [
	{ events: [think("Plan: read the file."), think(" Then answer.\n\n"), think("Second paragraph of the plan."), { type: "text_delta", text: "Looking." }, { type: "tool_call_end", callId: "e1", name: "list_dir", input: {} }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "The workspace is empty." }, { type: "usage", inputTokens: 1000, outputTokens: 20, cacheRead: 800, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] },
];
writeFileSync(join(data, "faux.json"), JSON.stringify(script));
const debugPort = String(9300 + Math.floor(Math.random() * 600));

const child = spawn(process.execPath, [electronCli, appDir], {
	env: {
		...process.env,
		electron_config_cache: process.env.electron_config_cache ?? join(process.env.HOME, "Library", "Caches", "electron"),
		KISO_DESKTOP_DATA: data,
		KISO_DESKTOP_WORKSPACE: workspace,
		KISO_DESKTOP_FAUX: join(data, "faux.json"),
		KISO_DESKTOP_ALLOW_ALL: "1",
		KISO_DESKTOP_DEBUG_PORT: debugPort,
		KISO_DESKTOP_AUTORUN: "what is in the workspace?",
	},
	stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let ready = null;
child.stdout.on("data", (d) => {
	stdout += d;
	for (const line of String(d).split("\n")) {
		if (line.startsWith("READY ")) ready = JSON.parse(line.slice(6));
		else if (line.startsWith("RENDERER ")) out(line.slice(0, 200));
	}
});
child.stderr.on("data", () => {});
const t0 = Date.now();
while (ready === null && Date.now() - t0 < 180_000) await sleep(200);
if (ready === null) throw new Error(`electron did not become ready:\n${stdout}`);
out(`READY ${JSON.stringify(ready)} (${Date.now() - t0} ms)`);

// the remote debugging port: find the page and ask it for its own state
const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
const page = targets.find((t) => t.type === "page");
out(`CDP page target: ${page.url.split("#")[0]} (token fragment removed from the address: ${!page.url.includes("token=")})`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (m) => {
	const msg = JSON.parse(m.data);
	pending.get(msg.id)?.(msg);
};
const evaluate = (expression) =>
	new Promise((resolve) => {
		const n = ++id;
		pending.set(n, (msg) => resolve(msg.result?.result?.value));
		ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
	});
let state;
for (let i = 0; i < 100; i++) {
	state = await evaluate("JSON.stringify({ done: window.__kiso?.done, events: window.__kiso?.events.length, types: window.__kiso?.events.map(e => e.type), frames: window.__kiso?.frames.map(f => f.event) })");
	if (state !== undefined && JSON.parse(state).done === true) break;
	await sleep(200);
}
out(`CDP page state: ${state}`);
const text = await evaluate("document.getElementById('log').innerText.split('\\n').slice(0, 14).join('\\n')");
out("page text (first lines):");
out(text);
const ok = JSON.parse(state).done === true && JSON.parse(state).types.includes("terminal");
out(`RESULT electron renderer received a streamed run: ${ok ? "PASS" : "FAIL"}`);
ws.close();
child.kill("SIGTERM");
await new Promise((r) => child.once("exit", r));
