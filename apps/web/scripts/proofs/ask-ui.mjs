// ADR-0062 PR 7 (§ 10c): ask_user in kiso web. A waiting call is a card in the stream (the question, "1 of 2", one row per
// option with "(Recommended)", Other, Skip and Next/Submit ⌘↩), the stream ends on "Needs your input" and the sidebar shows the
// Work waiting; the answer reaches the model as the terminal's shapes; a line typed in the box is the question's Other (S2);
// skipping every question declines. Screenshots go outside the repository.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

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
// a card is drawn at the call's start; the question is answerable only once the host holds it (the sidebar then reads waiting)
const answerable = () => waitUntil(async () => (await state()) === "waiting", 20_000);
const state = async () => (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).works.find((w) => w.id === "w-ask")?.state;

await q(`window.__kiso.send("Import the 2024 invoices.")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000);
check((await app.text(".q-head > span"))?.trim() === range.question && (await app.text(".q-pager"))?.replace(/\s+/g, " ").trim() === "‹ 1 of 2 ›", "the card: the question in its head, and ‹ 1 of 2 ›");
check((await app.count(".q-opt")) === 4 && (await q(`[...document.querySelectorAll(".q-opt b")].map((b) => b.textContent).join("|")`)) === "2024 only|2023 to 2024|Everything|Other", "one row per option, Other last");
check((await q(`document.querySelector(".q-opt i")?.textContent`))?.trim() === "(Recommended)" && (await q(`document.querySelector(".q-opt small")?.textContent`)) === "The invoices the request names", "the recommended option says so; each has its line of description");
check((await q(`document.querySelector("[data-act=q-next]").disabled`)) === true && (await q(`(dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true })), document.querySelector(".q-pager").textContent.replace(/\\s+/g, " ").trim())`)) === "‹ 1 of 2 ›", "nothing picked: Next is disabled and ⌘↩ does nothing; nothing is ever chosen for the person");
check(await waitUntil(async () => (await app.text("[data-kind=needs-input]")) === "Needs your input" && (await state()) === "waiting", 20_000), "the stream ends on Needs your input; the sidebar shows the Work waiting");
check(await waitUntil(async () => (await q(`document.querySelector('[data-kind=composer] textarea').placeholder`)) === "Answer, or pick above", 10_000), "the box says it answers the question");
// a new Work's row joins the list on its next read (up to ~3 s), then reads waiting
check(await waitUntil(async () => (await app.count(".item.on .dot.amber")) === 1 && (await app.count(".item.on .dot.run")) === 0, 15_000), "the open Work's sidebar row shows the amber waiting dot, not the spinner");
check((await q(`getComputedStyle(document.querySelector(".q-opt input")).accentColor`)) !== "auto", "the radios and boxes take the ink colour, not the browser's blue");
await app.shot("pr7-ask-1-of-2");
await q(`document.querySelectorAll(".q-opt input")[1].click()`);
await app.click("[data-act=q-next]");
check(await waitUntil(async () => (await app.text("[data-act=q-next]")) === "Submit ⌘↩" && (await q(`document.querySelector(".q-opt input").type`)) === "checkbox", 10_000), "the last question: Submit, and boxes for a multi-select");
await q(`document.querySelectorAll(".q-opt input")[0].click(); document.querySelectorAll(".q-opt input")[2].click()`);
check((await q(`document.querySelector("[data-act=q-other] input").click(); true`).then(() => waitUntil(async () => (await app.count(".q-text")) === 1, 10_000)).then(() => q(`(() => { const el = document.querySelector(".q-text"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, "Runtime"); el.dispatchEvent(new Event("input", { bubbles: true })); return [...document.querySelectorAll(".q-opt input:not(.q-text)")].map((x) => x.checked).join(); })()`))) === "true,false,true,true", "a multi-select keeps its picks when Other is ticked too");
check(await waitUntil(async () => (await app.count(".item.on .dot.amber")) === 1, 10_000), "still waiting on the second question: the amber dot");
await app.shot("pr7-ask-2-of-2");
await app.click("[data-act=q-next]");
await waitUntil(async () => result("a1") !== undefined, 15_000);
check(result("a1") === JSON.stringify({ answers: [{ q: range.question, choice: "2023 to 2024 (recommended)".replace(" (recommended)", "") }, { q: parts.question, choices: ["Importer", "Docs", "Runtime"] }] }), "the model reads the answers in the terminal's shapes");
check(await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 0 && (await app.count("[data-kind=needs-input]")) === 0, 15_000), "answered, the card and the marker are gone");
await q(`window.__kiso.send("And the 2023 ones?")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000);
await answerable();
await q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Only March 2023'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await q(`document.querySelector('[data-kind=composer] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
await waitUntil(async () => result("a2") !== undefined, 15_000);
check(result("a2") === JSON.stringify({ answers: [{ q: range.question, custom: "Only March 2023" }] }), "S2: a line typed in the box is the question's Other");
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 0, 15_000);
await q(`window.__kiso.send("Never mind the range.")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000);
await answerable();
await app.click("[data-act=q-skip]");
await waitUntil(async () => result("a3") !== undefined, 15_000);
check(result("a3") === JSON.stringify({ declined: [range.question] }), "skipping every question declines, in the terminal's shape");
// F8: the host is killed while a question waits: no card or marker left to answer; the model reads that it was never answered and
// asks again (a restarted scripted host starts its script over, so the call it makes on Resume is a1's again)
await q(`window.__kiso.send("Import them all.")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000).then(answerable).then(() => app.restart()); // killed once the host holds it, not while the call still streams
check(await waitUntil(async () => (await app.count("[data-kind=resume]")) === 1 && (await app.count("[data-kind=question-card]")) === 0 && (await app.count("[data-kind=needs-input]")) === 0, 20_000), "killed while a question waits: Resume, and no card or Needs your input left to answer");
await app.click("[data-act=resume]");
check(await waitUntil(() => /Ask it again: call ask_user/.test(result("a4") ?? ""), 15_000), "the model reads that the question was never answered");
check(!/Permission denied/.test(result("a4") ?? ""), "without a permission prefix");
check(await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1, 20_000), "and asks again: the card is back");
await app.close();
verdict();
