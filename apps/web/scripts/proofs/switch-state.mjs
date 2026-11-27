// Switching to a running Work: its row keeps the spinner from the first frame (it said idle until the page had read the Work).
import { checker, clientFor, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("switch-state");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const slow = { events: [{ type: "tool_call_end", callId: "k", name: "shell", input: { command: "sleep 30" } }, { type: "stop", reason: "tool_use" }] };
const app = await launchApp({ data: scratch("sw-data"), workspace: scratch("sw-ws"), env: { KISO_WEB_SESSION: "a1", KISO_WEB_MODE: "full-access" }, fauxScript: [say("Done."), slow] });
await app.evaluate(`window.__kiso.send("one")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0);
await clientFor(app.host()).session("b2").run("two");
if ((await app.evaluate("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]"); // it opens at first
await waitUntil(async () => (await app.count(".item[data-work=b2] .dot.run")) === 1);
// sample the row on every frame from the click until the page has read the Work; with each frame (finding #22: a CI-only idle frame),
// what decides the row: the session shown (the one from before the click or the new one), its snapshot, load, staleness and stream
const hist = async () => { const r = await fetch(`${app.host().origin}/desk/history`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((x) => x.json()); return `${Date.now()} history b2=${r.works?.find((w) => w.id === "b2")?.state} host running=${(await clientFor(app.host()).session("b2").state()).running}`; };
const before = await hist();
await app.evaluate(`(() => { window.__seen = []; const k0 = window.__kiso, row = () => document.querySelector('.item[data-work=b2]'); row().click(); const tick = () => { const k = window.__kiso; window.__seen.push([Math.round(performance.timeOrigin + performance.now()), row().dataset.state + (row().querySelector('.dot.run') ? '+sp' : ''), k === k0 ? 'old' : 'new', k.state.snapshot != null ? 'snap' : 'nosnap', k.loaded() ? 'loaded' : 'loading', k.stale() ? 'stale' : 'fresh', k.link().state.kind].join(' ')); if (window.__seen.length < 40) requestAnimationFrame(tick); }; tick(); })()`);
await sleep(1500);
const after = await hist(), frames = JSON.parse(await app.evaluate("JSON.stringify(window.__seen)")), rest = (f) => f.slice(f.indexOf(" "));
const seen = [...new Set(frames.map((f) => f.split(" ")[1]))].join(), changes = frames.filter((f, i) => i === 0 || rest(f) !== rest(frames[i - 1]));
check(seen === "running+sp", `the running Work's row is running with its spinner on every frame after the switch (${seen})${seen === "running+sp" ? "" : ` | before: ${before} | frames that changed: ${changes.join("; ")} | after: ${after}`}`);
await app.close();
verdict();
process.exit(process.exitCode ?? 0);
