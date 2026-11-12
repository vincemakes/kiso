// Switching to a running Work: its row keeps the spinner from the first frame (it said idle until the page had read the Work).
import { checker, clientFor, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("switch-state");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const slow = { events: [{ type: "tool_call_end", callId: "k", name: "shell", input: { command: "sleep 30" } }, { type: "stop", reason: "tool_use" }] };
const app = await launchApp({ data: scratch("sw-data"), workspace: scratch("sw-ws"), env: { KISO_WEB_SESSION: "a1", KISO_WEB_MODE: "full-access" }, fauxScript: [say("Done."), slow] });
await app.evaluate(`window.__kiso.send("one")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0);
await clientFor(app.host()).session("b2").run("two");
await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count(".item[data-work=b2] .sp")) === 1);
// sample the row on every frame from the click until the page has read the Work
await app.evaluate(`(() => { window.__seen = []; const row = () => document.querySelector('.item[data-work=b2]'); row().click(); const tick = () => { window.__seen.push(row().dataset.state + (row().querySelector('.sp') ? '+sp' : '')); if (window.__seen.length < 40) requestAnimationFrame(tick); }; tick(); })()`);
await sleep(1500);
const seen = await app.evaluate("[...new Set(window.__seen)].join()");
check(seen === "running+sp", `the running Work's row is running with its spinner on every frame after the switch (${seen})`);
await app.close();
verdict();
process.exit(process.exitCode ?? 0);
