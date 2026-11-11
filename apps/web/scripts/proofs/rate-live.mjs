// The footer's tok/s is the same live as read back and is the decode rate: `usage` and the deltas are sent with no time, and one asked for
// at the run's end read as now, so each call was timed to the run's end (a 14 tok/s footer for a 143 tok/s run). Two calls, one led by thinking, one by text, with a 3 s tool between: about 400 tokens over 2 s.
import { checker, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("rate-live");
const out = (n) => ({ type: "usage", inputTokens: 100, outputTokens: n, cacheRead: 0, cacheWrite: null, known: true });
// call 1 starts with thinking, then text, then a tool call that sleeps 3 s (not decode time); call 2 starts with text: 400 tokens over about 2 s of decoding
const think = Array.from({ length: 5 }, () => [{ type: "thinking", text: "t" }, { type: "delay", ms: 100 }]).flat();
const talk = Array.from({ length: 10 }, () => [{ type: "text_delta", text: "word " }, { type: "delay", ms: 100 }]).flat();
const sh = { type: "tool_call_end", callId: "k", name: "shell", input: { command: "sleep 3" } };
const app = await launchApp({ data: scratch("rt-data"), workspace: scratch("rt-ws"), env: { KISO_WEB_SESSION: "r1", KISO_WEB_MODE: "full-access" }, fauxScript: [{ events: [...think, ...talk.slice(0, 10), sh, out(200), { type: "stop", reason: "tool_use" }] }, { events: [...talk, out(200), { type: "stop", reason: "end_turn" }] }] });
await app.evaluate(`window.__kiso.send("go")`);
const rate = async (tab) => +((await tab.text("[data-kind=footer]")) ?? "").replace(/^.* (\d+) tok\/s$/, "$1");
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0, 20_000);
const live = await rate(app);
const back = await app.chrome.open(`${app.host().origin}/#session=r1`);
await waitUntil(async () => (await back.count("[data-kind=footer]")) > 0, 10_000);
const read = await rate(back);
check(live > 130 && live < 280 && Math.abs(live - read) <= read * 0.25, `the run's rate is the same live (${live}) and read back (${read}): a 3 s tool wait is not decode time`);
await back.close();
await app.closeTab();
await app.chrome.close();
verdict();
process.exit(process.exitCode ?? 0);
