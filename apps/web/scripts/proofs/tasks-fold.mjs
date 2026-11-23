// Finding #15: a Work with many ended background tasks keeps the rail short: the running ones and the five newest ended, then "Show n more".
import { clientFor, scratch, launchApp, waitUntil, checker } from "./lib.mjs";

const { check, verdict } = checker("tasks-fold");
const bg = (n, command) => ({ type: "tool_call_end", callId: `c${n}`, name: "shell", input: { command, description: `Task ${n}`, background: true } });
const calls = [...Array.from({ length: 9 }, (_, i) => bg(i + 1, `echo ${i + 1}`)), bg(10, "sleep 300")];
const app = await launchApp({ data: scratch("fold-data"), workspace: scratch("fold-ws"), env: { KISO_WEB_SESSION: "w-f", KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [{ events: [...calls, { type: "stop", reason: "tool_use" }] }, { events: [{ type: "text_delta", text: "Started." }, { type: "stop", reason: "end_turn" }] }, { events: [{ type: "text_delta", text: "Hi." }, { type: "stop", reason: "end_turn" }] }] });
const s = clientFor(app.host()).session("w-f");
await s.run("start them");
const rows = () => app.count("[data-field=task]");
check(await waitUntil(async () => (await app.text("[data-act=more-tasks]")) === "Show 4 more", 30_000), "nine ended tasks: the rail says Show 4 more");
check((await rows()) === 6, "one running and the five newest ended are listed");
await app.shot("tasks-fold");
await app.click("[data-act=more-tasks]");
check(await waitUntil(async () => (await rows()) === 10 && (await app.count("[data-act=more-tasks]")) === 0), "Show more lists all ten");
await app.shot("tasks-fold-all");
// another Work starts folded again: leave this one and come back
if ((await app.evaluate(`document.querySelector(".win").dataset.side`)) !== "1") await app.click("[data-act=sidebar]");
await app.click("[data-act=new]");
await app.evaluate(`window.__kiso.send("hello")`);
await waitUntil(async () => (await app.text("[data-kind=answer]")) === "Hi.", 30_000);
await app.click('.item[data-work="w-f"]');
check(await waitUntil(async () => (await app.text("[data-act=more-tasks]")) === "Show 4 more"), "leaving the Work and coming back folds its tasks again");
await app.close();
verdict();
