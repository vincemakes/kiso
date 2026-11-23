// Finding #15: a Work with many ended background tasks keeps the rail short: the running ones and the five newest ended, then "Show n more".
import { clientFor, scratch, launchApp, waitUntil, checker } from "./lib.mjs";

const { check, verdict } = checker("tasks-fold");
const bg = (n, command) => ({ type: "tool_call_end", callId: `c${n}`, name: "shell", input: { command, description: `Task ${n}`, background: true } });
const calls = [...Array.from({ length: 9 }, (_, i) => bg(i + 1, `echo ${i + 1}`)), bg(10, "sleep 300")];
const app = await launchApp({ data: scratch("fold-data"), workspace: scratch("fold-ws"), env: { KISO_WEB_SESSION: "w-f", KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [{ events: [...calls, { type: "stop", reason: "tool_use" }] }, { events: [{ type: "text_delta", text: "Started." }, { type: "stop", reason: "end_turn" }] }] });
const s = clientFor(app.host()).session("w-f");
await s.run("start them");
const rows = () => app.count("[data-field=task]");
check(await waitUntil(async () => (await app.text("[data-act=more-tasks]")) === "Show 4 more", 30_000), "nine ended tasks: the rail says Show 4 more");
check((await rows()) === 6, "one running and the five newest ended are listed");
await app.shot("tasks-fold");
await app.click("[data-act=more-tasks]");
check(await waitUntil(async () => (await rows()) === 10 && (await app.count("[data-act=more-tasks]")) === 0), "Show more lists all ten");
await app.shot("tasks-fold-all");
await app.close();
verdict();
