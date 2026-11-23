// ADR-0062 § 10c.1: a line from another Work, accepted by a Work whose run waits on ask_user, ends the question ("not answered",
// replaced) so the line is admitted at the next boundary; the card asked again keeps the person's picks for a question that did
// not change; the stream reads message above the new card. The per-run cap is proved on the bridge itself.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, clientFor, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("ask-replaced");
const range = { question: "Which year range should the import cover?", options: [{ label: "2024 only" }, { label: "2023 to 2024" }, { label: "Everything" }] };
const parts = { question: "Which parts should it touch?", options: [{ label: "Importer" }, { label: "Schema" }] };
const parts2 = { question: "Which parts, after the message?", options: [{ label: "Importer" }, { label: "Schema" }] };
const ask = (callId, questions) => ({ events: [{ type: "tool_call_end", callId, name: "ask_user", input: { questions } }, { type: "stop", reason: "tool_use" }] });
const send = { events: [{ type: "tool_call_end", callId: "m1", name: "message", input: { to: "import work", text: "the invoices moved to a new folder" } }, { type: "stop", reason: "tool_use" }] };
const ok = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const data = scratch("replaced-data");
// two requests follow the message at once (the sender's next step, the receiver's): both are the same call, so the order they land in is not the proof's
const app = await launchApp({ data, workspace: scratch("replaced-ws"), env: { KISO_WEB_SESSION: "w-ask", KISO_WEB_SESSIONS: "on" }, fauxScript: [ask("a1", [range, parts]), send, ask("a2", [range, parts2]), ask("a2", [range, parts2]), ok] });
const host = () => app.host();
const q = (js) => app.evaluate(js);
const key = (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).current.key;
const events = (id) => readFileSync(join(data, "projects", key, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const state = async () => (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).works.find((w) => w.id === "w-ask")?.state;

await q(`window.__kiso.send("import work")`);
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1 && (await state()) === "waiting", 20_000);
await q(`document.querySelectorAll(".q-opt input")[1].click()`); // the person has picked "2023 to 2024" and not yet gone on
await app.shot("pr-f-1-card-with-a-pick");
await clientFor(host()).session("w-send").run("sender task");
const result = () => events("w-ask").find((e) => e.type === "tool_result" && e.callId === "a1")?.content;
check(await waitUntil(() => result() !== undefined, 15_000), "the message ends the waiting question: its call has a result at once, without the person");
const r = JSON.parse(result());
check(JSON.stringify(r.declined) === JSON.stringify([range.question, parts.question]) && r.replaced === true && /^Not answered: another session sent this Work a message/.test(r.reason) && /call ask_user again/.test(r.reason), "the result is the not-answered shape: every question declined, replaced, with a reason to ask again");
await waitUntil(() => events("w-ask").some((e) => e.type === "tool_call_end" && e.callId === "a2"), 15_000);
const log = events("w-ask");
const at = (f) => log.findIndex(f);
check(at((e) => e.type === "tool_result" && e.callId === "a1") < at((e) => e.type === "user_input" && e.via?.kind === "peer") && at((e) => e.type === "user_input" && e.via?.kind === "peer") < at((e) => e.type === "tool_call_end" && e.callId === "a2"), "the message is admitted after the ended question and before the model asks again");
await waitUntil(async () => (await app.count("[data-kind=question-card]")) === 1 && (await q(`document.querySelector(".q-head > span")?.textContent`)) === range.question && (await app.count("[data-kind=peer-row]")) === 1, 20_000);
check((await q(`document.querySelector("[data-tool=ask_user] .s-verb")?.textContent`)) === "Question replaced" && (await q(`document.querySelector("[data-tool=ask_user] .s-out")`)) === null, "the old card is folded to one line: Question replaced");
check((await q(`!!(document.querySelector("[data-kind=peer-row]").compareDocumentPosition(document.querySelector("[data-kind=question-card]")) & Node.DOCUMENT_POSITION_FOLLOWING)`)) === true, "the message row is drawn above the card");
check((await q(`document.querySelectorAll(".q-opt input")[1].checked`)) === true && (await q(`document.querySelectorAll(".q-opt input")[0].checked`)) === false, "the question that did not change keeps the person's pick");
await sleep(700); // past the card's entrance
await app.shot("pr-f-2-replaced-and-asked-again");
await app.click("[data-act=q-next]");
await sleep(200);
check((await q(`[...document.querySelectorAll(".q-opt input")].some((i) => i.checked)`)) === false, "a question that changed starts empty");
await app.shot("pr-f-3-the-changed-question-starts-empty");
await app.close();

// the cap: three questions of a run end for a line; the fourth waits for the person, as before
const { AskBridge } = await import("../../dist/main/ask-bridge.js");
const bridge = new AskBridge();
const run = { aborted: false };
const spec = { questions: [{ question: "A?", options: [] }] };
const outcomes = [];
for (let i = 1; i <= 4; i++) {
	const p = bridge.ui.ask(spec, run, { sessionId: "s", callId: `c${i}` });
	const ended = bridge.replaceWaiting("s");
	outcomes.push(ended);
	if (!ended) bridge.answer("s", `c${i}`, { answers: [{ q: "A?", choice: "x" }] });
	await p;
}
check(JSON.stringify(outcomes) === "[true,true,true,false]", "per run, three questions end for incoming lines; the fourth waits for its answer");
const other = bridge.ui.ask(spec, { aborted: false }, { sessionId: "s", callId: "d1" });
check(bridge.replaceWaiting("s") === true && (await other).replaced === true, "another run has its own allowance");
check(bridge.replaceWaiting("s") === false && bridge.replaceWaiting("nobody") === false, "nothing waiting: false, and the line is handed on as before");
verdict();
