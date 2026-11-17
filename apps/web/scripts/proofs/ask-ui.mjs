// ADR-0062 PR 7 (§ 10c): ask_user in kiso web. A waiting call is a card in the stream (the question, "1 of 2", one row per
// option with "(Recommended)", Other, Skip and Next/Submit ⌘↩), the stream ends on "Needs your input" and the sidebar shows the
// Work waiting; the answer reaches the model as the terminal's shapes; a line typed in the box is the question's Other (S2);
// skipping every question declines. Screenshots go outside the repository.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("ask-ui");
const ok = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const ask = (callId, questions) => ({ events: [{ type: "tool_call_start", callId, name: "ask_user" }, { type: "delay", ms: 600 }, { type: "tool_call_end", callId, name: "ask_user", input: { questions } }, { type: "stop", reason: "tool_use" }] }); // streamed as a real model streams it: the call first, its input later
const range = { question: "Which year range should the import cover?", options: [{ label: "2024 only (recommended)", description: "The invoices the request names" }, { label: "2023 to 2024", description: "Two years, for the comparisons" }, { label: "Everything", description: "All invoices on record" }] };
const parts = { question: "Which parts should it touch?", multiSelect: true, options: [{ label: "Importer" }, { label: "Schema" }, { label: "Docs" }] };
const data = scratch("ask-data");
const app = await launchApp({ data, workspace: scratch("ask-ws"), env: { KISO_WEB_SESSION: "w-ask" }, fauxScript: [ask("a1", [range, parts]), ok, ask("a2", [range]), ok, ask("a3", [range]), ok, ask("a4", [range]), ok] });
const q = (js) => app.evaluate(js);
const host = () => app.host();
const key = (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).current.key;
const result = (callId) => readFileSync(join(data, "projects", key, "w-ask.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event).find((e) => e.type === "tool_result" && e.callId === callId)?.content;
const state = async () => (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).works.find((w) => w.id === "w-ask")?.state;

await q(`window.__kiso.send("Import the 2024 invoices.")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000);
check((await app.text(".q-head > span"))?.trim() === range.question && (await app.text(".q-pager"))?.replace(/\s+/g, " ").trim() === "‹ 1 of 2 ›", "the card: the question in its head, and ‹ 1 of 2 ›");
check((await app.count(".q-opt")) === 4 && (await q(`[...document.querySelectorAll(".q-opt b")].map((b) => b.textContent).join("|")`)) === "2024 only|2023 to 2024|Everything|Other", "one row per option, Other last");
check((await q(`document.querySelector(".q-opt i")?.textContent`))?.trim() === "(Recommended)" && (await q(`document.querySelector(".q-opt small")?.textContent`)) === "The invoices the request names", "the recommended option says so; each has its line of description");
check((await app.text("[data-kind=needs-input]")) === "Needs your input" && (await state()) === "waiting", "the stream ends on Needs your input; the sidebar shows the Work waiting");
check((await q(`document.querySelector('[data-kind=composer] textarea').placeholder`)) === "Answer, or pick above", "the box says it answers the question");
await waitUntil(async () => (await app.count(".item.on")) === 1, 10_000).then(() => sleep(600)); // a new Work's row joins the list on its next read (up to ~3 s); then past the card's entrance
check((await app.count(".item.on .dot.amber")) === 1 && (await app.count(".item.on .sp")) === 0, "the open Work's sidebar row shows the amber waiting dot, not the spinner");
check((await q(`getComputedStyle(document.querySelector(".q-opt input")).accentColor`)) !== "auto", "the radios and boxes take the ink colour, not the browser's blue");
await app.shot("pr7-ask-1-of-2");
await q(`document.querySelectorAll(".q-opt input")[1].click()`);
await app.click("[data-act=q-next]");
await sleep(200);
check((await app.text("[data-act=q-next]")) === "Submit ⌘↩" && (await q(`document.querySelector(".q-opt input").type`)) === "checkbox", "the last question: Submit, and boxes for a multi-select");
await q(`document.querySelectorAll(".q-opt input")[0].click(); document.querySelectorAll(".q-opt input")[2].click()`);
check((await app.count(".item.on .dot.amber")) === 1, "still waiting on the second question: the amber dot");
await app.shot("pr7-ask-2-of-2");
await app.click("[data-act=q-next]");
await waitUntil(async () => result("a1") !== undefined, 15_000);
check(result("a1") === JSON.stringify({ answers: [{ q: range.question, choice: "2023 to 2024 (recommended)".replace(" (recommended)", "") }, { q: parts.question, choices: ["Importer", "Docs"] }] }), "the model reads the answers in the terminal's shapes");
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 0 && (await app.count("[data-kind=needs-input]")) === 0, 15_000);
check(true, "answered, the card and the marker are gone");
await q(`window.__kiso.send("And the 2023 ones?")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000);
await q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Only March 2023'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await q(`document.querySelector('[data-kind=composer] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
await waitUntil(async () => result("a2") !== undefined, 15_000);
check(result("a2") === JSON.stringify({ answers: [{ q: range.question, custom: "Only March 2023" }] }), "S2: a line typed in the box is the question's Other");
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 0, 15_000);
await q(`window.__kiso.send("Never mind the range.")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000);
await app.click("[data-act=q-skip]");
await waitUntil(async () => result("a3") !== undefined, 15_000);
check(result("a3") === JSON.stringify({ declined: [range.question] }), "skipping every question declines, in the terminal's shape");
// F8: the host is killed while a question waits: no card or marker left to answer; the model reads that it was never answered and
// asks again (a restarted scripted host starts its script over, so the call it makes on Resume is a1's again)
await q(`window.__kiso.send("Import them all.")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000).then(() => app.restart());
check(await waitUntil(async () => (await app.count("[data-kind=resume]")) === 1 && (await app.count("[data-kind=question-card]")) === 0 && (await app.count("[data-kind=needs-input]")) === 0, 20_000), "killed while a question waits: Resume, and no card or Needs your input left to answer");
await app.click("[data-act=resume]");
check((await waitUntil(() => /Ask it again: call ask_user/.test(result("a4") ?? ""), 15_000)) && !/Permission denied/.test(result("a4")) && (await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000)), "the model reads that the question was never answered, without a permission prefix, and asks again: the card is back");
await app.close();
verdict();
