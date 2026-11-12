// A background task is named by what it does, not by its first words or its id: a chain is never named by its first part, a leading
// `cd <path> &&` is dropped only when one simple command is left, a promoted foreground command keeps its name. A notice names the
// task in its own Work (two Works that both have a t1 never mix), is not repeated by a reload, and a row does not move while a task writes.
import { checker, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("tasks-ui");
const ws = scratch("tn-ws");
const call = (callId, input) => ({ type: "tool_call_end", callId, name: "shell", input });
const stop = { type: "stop", reason: "tool_use" };
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const app = await launchApp({ data: scratch("tn-data"), workspace: ws, env: { KISO_WEB_SESSION: "a", KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [
	{ events: [call("c1", { command: `cd ${ws} && ls`, background: true }), call("c2", { command: "echo first && sleep 60", background: true }), call("c3", { command: "sleep 5; echo done", foregroundMs: 500 }), call("c4", { command: "while true; do echo tick; sleep 0.2; done", background: true }), stop] },
	say("A started."),
	{ events: [call("d1", { command: "echo b && sleep 1", background: true }), stop] },
	say("B started."), say("A next."), say("B next."),
] });
const q = (js) => app.evaluate(js);
const titles = () => q("[...document.querySelectorAll('[data-field=task] .r-nm')].map((e) => e.textContent).join('|')");
await q(`window.__kiso.send("start")`);
check(await waitUntil(async () => (await app.count("[data-field=task]")) === 4, 30_000), "the Work's four tasks are listed");
const want = ["ls", "echo first && sleep 60", "sleep 5; echo done", "while true; do echo tick; sleep 0.2; done"];
const seen = (await titles()).split("|");
check(want.every((w) => seen.includes(w)) && !seen.some((s) => /^cd |^echo first$|\bt\d\b/.test(s)), `named by what they do: a leading cd dropped for one simple command, a chain or a waiting command shown whole, the id nowhere (${seen.join(" | ")})`);
const order = new Set();
for (let i = 0; i < 8; i++) (order.add(await titles()), await sleep(250));
check(order.size === 1 && (await titles()).startsWith("while true"), "newest start first, and the order does not move while a task writes output");
const tab = await app.chrome.open(`${app.host().origin}/#session=b`);
await tab.front();
await tab.evaluate(`window.__kiso.send("start b")`);
await waitUntil(async () => (await tab.count("[data-kind=footer]")) === 1, 30_000);
await app.front();
await q(`window.__kiso.send("again")`);
const notices = () => q("[...document.querySelectorAll('[data-kind=notice]')].map((e) => e.textContent).join('|')");
check(await waitUntil(async () => /^ls finished/.test(await notices()), 20_000), "A's notice names its task: 'ls finished'");
await sleep(2500); // its task ends between B's runs: the notice comes with the next one
await tab.front();
await tab.evaluate(`window.__kiso.send("again b")`);
await waitUntil(async () => (await tab.count("[data-kind=notice]")) >= 1, 20_000);
check(/echo b && sleep 1 finished/.test(await tab.text("[data-kind=notice]")) && !/ls finished/.test(await tab.text("[data-kind=notice]")), "B has a t1 too, and its notice names B's own task, not A's");
await tab.close();
const again = await app.chrome.open(`${app.host().origin}/#session=a`);
await again.front();
await waitUntil(async () => (await again.count("[data-field=task]")) === 4 && (await again.count("[data-kind=notice]")) >= 1, 20_000);
const [rows, notes] = [await again.evaluate("[...document.querySelectorAll('[data-field=task] .r-nm')].map((e) => e.textContent).sort().join('|')"), await again.count("[data-kind=notice]")];
check(rows === [...want].sort().join("|") && notes === 1, `after a reload the titles are the same (the promoted command too) and the notice is not repeated (${notes})`);
await again.close();
await app.close();
verdict();
process.exit(process.exitCode ?? 0);
