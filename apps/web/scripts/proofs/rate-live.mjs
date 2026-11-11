// The footer's tok/s is the same live as read back: a call that begins with thinking (a delta, which is not sent with a time) used to be
// timed from the run's end, so a live run showed no rate or a wrong one. 400 tokens over about 2 s of thinking and text: about 200.
import { checker, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("rate-live");
const evs = [];
for (let i = 0; i < 10; i++) evs.push({ type: "thinking", text: "t" }, { type: "delay", ms: 100 });
for (let i = 0; i < 10; i++) evs.push({ type: "text_delta", text: "word " }, { type: "delay", ms: 100 });
evs.push({ type: "usage", inputTokens: 100, outputTokens: 400, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" });
const app = await launchApp({ data: scratch("rt-data"), workspace: scratch("rt-ws"), env: { KISO_WEB_SESSION: "r1" }, fauxScript: [{ events: evs }] });
await app.evaluate(`window.__kiso.send("go")`);
const rate = async (tab) => +((await tab.text("[data-kind=footer]")) ?? "").replace(/^.* (\d+) tok\/s$/, "$1");
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0, 20_000);
const live = await rate(app);
const back = await app.chrome.open(`${app.host().origin}/#session=r1`);
await waitUntil(async () => (await back.count("[data-kind=footer]")) > 0, 10_000);
const read = await rate(back);
check(live > 120 && live < 320 && Math.abs(live - read) <= read * 0.25, `the run's rate is the same live (${live}) and read back (${read}): about 400 tokens over 2 s`);
await back.close();
await app.closeTab();
await app.chrome.close();
verdict();
process.exit(process.exitCode ?? 0);
