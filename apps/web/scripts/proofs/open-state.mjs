// Opening a Work reads its state once after the replay, not once per replayed run (a Work with many runs asked the host 79 times, each
// about 0.3 s of host time on a big log); a run that is live when the page opens, or starts or ends after it, is still read at once.
import { checker, clientFor, launchApp, scratch, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("open-state");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const slow = { events: [{ type: "tool_call_end", callId: "k", name: "shell", input: { command: "sleep 3" } }, { type: "stop", reason: "tool_use" }] };
const app = await launchApp({ data: scratch("os-data"), workspace: scratch("os-ws"), env: { KISO_WEB_SESSION: "other", KISO_WEB_MODE: "full-access" }, fauxScript: [...Array.from({ length: 12 }, (_, i) => say(`answer ${i}`)), slow, say("last")] });
const s = clientFor(app.host()).session("many");
for (let i = 0; i < 12; i++) {
	await s.run(`question ${i}`);
	await waitUntil(async () => !(await s.state()).running);
}
const states = (tab) => tab.evaluate("performance.getEntriesByType('resource').filter((e) => /\\/state(\\?|$)/.test(e.name)).length");
const tab = await app.chrome.open(`${app.host().origin}/#session=many`);
await tab.front();
check(await waitUntil(async () => (await tab.count("[data-kind=footer]")) === 12 && (await tab.evaluate("window.__kiso.loaded()")), 30_000), "the Work with twelve runs opens");
const opened = await states(tab);
check(opened <= 3, `its replay asked the host for the state ${opened} times (twelve runs, 24 events that used to ask)`);
await s.run("a slow one");
check(await waitUntil(async () => (await tab.count("[data-act=stop]")) === 1, 10_000), "a run that starts after the open is read at once: Stop shows");
check(await waitUntil(async () => (await tab.count("[data-kind=footer]")) === 13 && (await tab.count("[data-act=stop]")) === 0, 20_000), "and its end is read at once: the footer, no Stop");
// the skeleton that shows while a Work opens: nothing for 300 ms, then message-shaped rows with a shimmer
const sk = await tab.evaluate(`(() => { const d = document.createElement("div"); d.innerHTML = '<div class="loading"><i class="me-sk"></i><i></i><i></i><i></i></div>'; document.body.append(d); const l = getComputedStyle(d.firstChild), i = getComputedStyle(d.querySelector("i:nth-child(3)")); const r = [l.animationDelay, i.animationName, getComputedStyle(d.querySelector(".me-sk")).alignSelf].join(); d.remove(); return r; })()`);
check(sk === "0.3s,sheen,flex-end", `the opening skeleton waits 300 ms, shimmers, and has a message-shaped row on the person's side (${sk})`);
await tab.close();
await app.close();
verdict();
process.exit(process.exitCode ?? 0);
