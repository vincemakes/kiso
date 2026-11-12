// A few Works' page state is kept, so switching back shows one at once: the state outlives the stream (only the shown Work holds one), the
// stream resumes from the last applied event, and an approval or a running state drawn from before the switch is not offered as current.
import { checker, clientFor, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";
import { WorkCache, slotOf, weigh } from "../../src/renderer/state/workcache.ts";

const { check, verdict } = checker("work-cache");
// the cache: least recently shown first by count and by estimated size; the shown Work is never dropped; a Work is its folder AND its id
const fake = (turns) => { const s = { state: { turns, tasks: [] }, gone: false, detach() { this.gone = true; } }; return s; };
const turn = (n) => ({ user: "x", detail: null, items: [{ kind: "text", text: "y".repeat(n) }] });
const keep = (cache, k, w) => (cache.acquire(slotOf(null, k), () => w), cache.release(slotOf(null, k)), w);
const c = new WorkCache(3, 1e6);
const [wa, , , wd] = ["a", "b", "c", "d"].map((k) => keep(c, k, fake([turn(10)])));
check(c.stats().works === 3 && wa.gone && !wd.gone, "at most the allowed number of Works are kept, the least recently shown goes");
const m = new WorkCache(10, 3000);
const [ma, mb] = [keep(m, "a", fake([turn(10)])), keep(m, "b", fake([turn(10)]))];
keep(m, "big", fake([turn(400)]));
const me = fake([turn(10)]);
m.acquire(slotOf(null, "e"), () => me);
check(ma.gone && !mb.gone && !me.gone, "over the memory estimate the oldest goes, and the Work being shown stays");
check(slotOf("k1", "s") !== slotOf("k2", "s") && slotOf(null, "s") === slotOf(null, "s") && weigh({ turns: [turn(1000)], tasks: [] }) > weigh({ turns: [turn(10)], tasks: [] }), "a Work is its folder key and its id; the estimate follows the text");
// the page
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const ask = { events: [{ type: "tool_call_end", callId: "k", name: "shell", input: { command: "echo asked" } }, { type: "stop", reason: "tool_use" }] };
const app = await launchApp({ data: scratch("wc-data"), workspace: scratch("wc-ws"), env: { KISO_WEB_SESSION: "big", KISO_WEB_MODE: "default" }, fauxScript: [...Array.from({ length: 6 }, (_, i) => say(`answer ${i}`)), say("small one"), ask, say("after the ask")] });
const h = clientFor(app.host());
const q = (js) => app.evaluate(js);
for (let i = 0; i < 6; i++) { await h.session("big").run(`question ${i}`); await waitUntil(async () => !(await h.session("big").state()).running); }
await h.session("small").run("hi");
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 6 && (await q("window.__kiso.loaded()")), 30_000);
await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count(".item[data-work=small]")) === 1);
await q("window.__big = window.__kiso");
await app.click(".item[data-work=small]");
await waitUntil(async () => (await q("window.__kiso.state.turns.length")) === 1);
// while away, the big Work asks for an approval
await h.session("big").run("run a command");
await waitUntil(async () => (await h.session("big").state()).pendingApprovals.length === 1);
const t0 = Date.now();
await app.click(".item[data-work=big]");
check(await waitUntil(async () => (await q("window.__kiso === window.__big && window.__kiso.state.turns.length === 7")), 200, 10), `back on the big Work its runs are drawn at once, from the kept state, not a new one (${Date.now() - t0} ms)`);
check(await waitUntil(async () => (await app.count("[data-kind=ask]")) === 1 && (await q("document.querySelector('[data-act=allow]').disabled")) === false && !(await q("window.__kiso.stale()")), 10_000), "the approval that came while it was away shows, and is answerable once the host has been read");
await app.click("[data-act=allow]");
check(await waitUntil(async () => (await app.count("[data-kind=footer]")) === 7 && (await app.count("[data-kind=answer]")) === 7, 20_000), "answering it finishes the run: seven answers, none lost, none doubled");
await app.closeTab();
await app.chrome.close();
verdict();
process.exit(process.exitCode ?? 0);
