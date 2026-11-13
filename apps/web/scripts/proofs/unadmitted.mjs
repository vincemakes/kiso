// A steer a run accepted but never admitted (the run ended first) becomes a new run, started by the page, once.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("unadmitted");
const app = await launchApp({ data: scratch("un-data"), workspace: scratch("un-ws"), env: { KISO_WEB_SESSION: "un" }, fauxScript: [
	{ events: [{ type: "delay", ms: 1200 }, { type: "fail", code: "bad_request", status: 400, retryable: false, message: "scripted failure" }] },
	{ events: [{ type: "text_delta", text: "Got the late line." }, { type: "stop", reason: "end_turn" }] },
] });
await app.evaluate(`window.__kiso.send("first request")`);
await sleep(400);
await app.evaluate(`window.__kiso.steer("late line")`);
check(await waitUntil(() => app.evaluate(`document.body.textContent.includes('Got the late line.')`), 20_000), "the late line is answered by a run of its own");
await sleep(1500);
check((await app.evaluate(`JSON.stringify(window.__kiso.state.turns.map((t) => t.user))`)) === '["first request","late line"]' && (await app.evaluate(`document.body.textContent.split('Got the late line.').length - 1`)) === 1, "it is one new run: two requests, the answer once");
await app.close();

// a steer the run has not taken yet is drawn at once; it can be taken back, or sent now as the next turn
const say = (text, ms = 0) => ({ events: [{ type: "delay", ms }, { type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const p = await launchApp({ data: scratch("pd-data"), workspace: scratch("pd-ws"), env: { KISO_WEB_SESSION: "pd", KISO_WEB_MODE: "full-access" }, fauxScript: [
	{ events: [{ type: "delay", ms: 3000 }, { type: "tool_call_end", callId: "c1", name: "shell", input: { command: "echo one" } }, { type: "stop", reason: "tool_use" }] },
	say("took it"), say("done again", 3000), say("slow", 8000), say("on it"),
] });
const waiting = () => p.evaluate("[...document.querySelectorAll('[data-kind=pending-steer] .steer')].map((e) => e.textContent).join('|')");
await p.evaluate(`window.__kiso.send("go")`);
await sleep(600);
await p.evaluate(`window.__kiso.steer("first steer")`);
check(await waitUntil(async () => (await waiting()) === "first steer", 1000, 50), "a steer shows at once, as waiting, before the run takes it");
check(await waitUntil(async () => (await waiting()) === "" && (await p.evaluate("[...document.querySelectorAll('.steer')].some((e) => e.textContent === 'first steer')")), 15_000), "once the run takes it, it is an ordinary steer and nothing waits");
await waitUntil(async () => (await p.count("[data-kind=footer]")) === 1, 15_000);
await p.evaluate(`window.__kiso.send("again")`);
await sleep(600);
await p.evaluate(`window.__kiso.steer("drop me")`);
await waitUntil(async () => (await waiting()) === "drop me", 2000, 50);
await p.click("[data-act=pending-cancel]");
check(await waitUntil(async () => (await waiting()) === "" && (await p.evaluate("document.querySelector('textarea').value")) === "drop me", 3000, 50), "taken back, it is gone at once and its text is back in the box");
await p.evaluate("(() => { const t = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, ''); t.dispatchEvent(new Event('input', { bubbles: true })); })()");
await waitUntil(async () => (await p.count("[data-kind=footer]")) === 2, 15_000);
await sleep(1200);
check(!(await p.evaluate("document.body.textContent.includes('drop me')")) && (await p.evaluate("window.__kiso.state.turns.length")) === 2, "the run never sees it, and no run starts from it");
await p.evaluate(`window.__kiso.send("third")`);
await sleep(600);
await p.evaluate(`window.__kiso.steer("now please")`);
await waitUntil(async () => (await waiting()) === "now please", 2000, 50);
await p.click("[data-act=send-now]");
check(await waitUntil(async () => (await p.evaluate("window.__kiso.state.turns.at(-1)?.user")) === "now please" && (await p.evaluate("document.body.textContent.includes('on it')")), 20_000), "Send now stops the step and sends the line as the next turn");
await p.close();
verdict();
