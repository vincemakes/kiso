// The follow-up (plan follow-up rev 2, owner 2026-11-03): after a run the page watched end well, the input box offers the
// line the person may send next, written by the Work's own model through Session.followUp (the run's request as the
// prefix; the runtime's follow-up test pins the bytes). The empty box's placeholder shows it, Tab takes it; coming back to
// the Work after a reload shows it again without asking the model again; the next run clears it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("followup");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("fu-data");
const app = await launchApp({ data, workspace: scratch("fu-ws"), fauxScript: [say("sub adds instead of subtracting."), say('"Fix the sub bug"'), say("Fixed.")], env: { KISO_WEB_SESSION: "fu", KISO_WEB_FOLLOWUP: "on" } });
const q = (js) => app.evaluate(js);
const box = "document.querySelector('[data-kind=composer] textarea')";
await q(`window.__kiso.send("What is wrong in calc.js?")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
check(await waitUntil(async () => (await q(`${box}.placeholder`)) === "Fix the sub bug", 15_000), `after the run the empty box offers the model's next line, one line, unquoted ("${await q(`${box}.placeholder`)}")`);
await app.shot("followup-0");
await q(`${box}.focus(); ${box}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); true`);
check(await waitUntil(async () => (await q(`${box}.value`)) === "Fix the sub bug"), "Tab takes it into the box");
await q(`(() => { const el = ${box}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await q("location.reload()");
await sleep(2000);
const trace = () => readFileSync(join(data, "projects", readdirSync(join(data, "projects"))[0], "traces", "fu.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "request").map((l) => l.purpose ?? "run");
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count('.item[data-work="fu"]')) === 1, 20_000);
await app.click('.item[data-work="fu"]');
const replayed = await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 20_000);
await sleep(500);
const after = await q(`${box}?.placeholder ?? null`);
check(replayed && after === "Fix the sub bug" && JSON.stringify(trace()) === '["run","follow-up"]', `back to the Work after a reload: the same line ("${after}"), and no second ask of the model (${trace().join()})`);
await q(`window.__kiso.send("Fix it")`);
const cleared = await waitUntil(async () => (await q(`${box}.placeholder`)) !== "Fix the sub bug", 10_000);
check(cleared && (await waitUntil(async () => (await q("[...document.querySelectorAll('.ans')].at(-1)?.textContent ?? ''")) === "Fixed.", 20_000)) && JSON.stringify(trace()).startsWith('["run","follow-up","run"'), `the next run clears the line and is answered by the next scripted turn: the follow-up took exactly one (${trace().join()})`);
await app.close();
verdict();
