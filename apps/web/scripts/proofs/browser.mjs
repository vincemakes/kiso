// `kiso-web` serves the page and a browser draws a whole run through kiso-client: signed in by the one-time code in the address (traded
// for a cookie and stripped from the address), a background: true command under its own task runner, the answer and the folded process.
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("browser");
const script = [
	{ events: [{ type: "thinking", text: "Plan: look at the folder." }, { type: "text_delta", text: "Looking." }, { type: "tool_call_end", callId: "e1", name: "list_dir", input: {} }, { type: "tool_call_end", callId: "e2", name: "shell", input: { command: "sleep 4; echo bg-done", background: true } }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "The workspace is **empty**." }, { type: "usage", inputTokens: 1000, outputTokens: 20, cacheRead: 800, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] },
];
const app = await launchApp({ data: scratch("br-data"), workspace: scratch("br-ws"), fauxScript: script, env: { KISO_WEB_MODE: "full-access", KISO_WEB_AUTORUN: "what is in the workspace?" } });
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null), "the page drew a whole run, up to its footer");
check((await app.count(".step[data-tool=shell] .bgtag")) === 1 && !(await app.text(".step[data-tool=shell]")).includes("did not record"), "a background: true command started its task runner");
check(await waitUntil(async () => /t1 · exited 0/.test((await app.text(".step[data-tool=shell] .s-req")) ?? ""), 10_000), "the task ended exited 0");
check((await app.text("[data-kind=me]")) === "what is in the workspace?" && (await app.text("[data-kind=answer]")) === "The workspace is empty.", "the person's line and the answer");
check((await app.text("[data-kind=answer] b")) === "empty", "bold is an element, not asterisks");
check((await app.evaluate("document.querySelector('[data-kind=process]').dataset.folded")) === "true", "the process is folded after the run");
check(/in · .* out · \d+% cache/.test(await app.text("[data-kind=footer]")), "the footer");
check((await app.evaluate("location.hash")) === "" && (await app.evaluate("document.cookie")) === "", "the connect code is gone from the address, and the page cannot read its session cookie (HttpOnly)");
await app.close();
verdict();
