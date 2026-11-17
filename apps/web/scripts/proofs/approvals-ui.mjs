// ADR-0062 § 14 test 25 (S3 at its edge): a line typed under an approval at the moment the approval is answered elsewhere is
// admitted exactly once, and the approval decided once, whichever lands first.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("approvals-ui");
const ok = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const shell = (callId, command) => ({ type: "tool_call_end", callId, name: "shell", input: { command } });
const data = scratch("approvals-data");
const app = await launchApp({ data, workspace: scratch("approvals-ws"), env: { KISO_WEB_SESSION: "w", KISO_WEB_MODE: "default" }, fauxScript: [{ events: [shell("a1", "npm install"), { type: "stop", reason: "tool_use" }] }, ok, ok] });
const q = (js) => app.evaluate(js);
const s = clientFor(app.host()).session("w");
const key = (await fetch(`${app.host().origin}/desk/history`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json())).current.key;
const log = () => readFileSync(join(data, "projects", key, "w.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const lines = (text) => log().filter((e) => e.type === "user_input" && e.content === text).length;
const open = () => log().filter((e) => e.type === "permission_requested" && !log().some((d) => d.type === "permission_decided" && d.decisionId === e.decisionId));
const type = (text) => q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
const idle = async () => (await waitUntil(async () => !(await s.state()).running, 15_000), await sleep(500));

await q(`window.__kiso.send("Install the dependencies.")`);
await waitUntil(async () => (await app.count("[data-kind=ask]")) === 1 && open().length === 1, 15_000);
await Promise.all([s.approve(open()[0].decisionId, true).catch(() => undefined), type("Then run the tests.")]); // the race
await waitUntil(() => lines("Then run the tests.") > 0, 15_000).then(idle); // the approval first: the line is handed back and sent as the next run
check(lines("Then run the tests.") === 1, "the line typed while the approval resolves is admitted exactly once");
check(log().filter((e) => e.type === "permission_decided").length === 1, "the approval is decided once, by whichever landed first");

await app.close();
verdict();
