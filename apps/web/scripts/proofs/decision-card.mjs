// The decision card (plan-decision-card-2026-11-24): finish_with_choices ends the run with no further request (core's END_TURN), the
// card is drawn from the log, a click sends {callId, option} and the host appends the canonical label marked as a pick, a forged
// label is never read, an overtaken card is a 409, and ⌘↩ takes the recommended choice. No model: a scripted adapter.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("decision-card");
const finish = (callId, choices, recommended) => ({ events: [{ type: "text_delta", text: "I would go with the first." }, { type: "tool_call_end", callId, name: "finish_with_choices", input: { choices, ...(recommended === undefined ? {} : { recommended }) } }, { type: "stop", reason: "tool_use" }] });
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("dc-data");
const app = await launchApp({ data, workspace: scratch("dc-ws"), env: { KISO_WEB_SESSION: "w-dc" }, fauxScript: [finish("c1", ["Go with JSON", "Keep CSV only"]), say("Kept CSV."), finish("c2", ["Alpha", "Beta", "Gamma"], false), say("Alpha taken."), finish("c3", ["One", "Two"]), say("One taken."), finish("c1", ["Five", "Six"]), say("Typed line taken.")] });
const host = () => app.host();
const hdr = () => ({ authorization: `Bearer ${host().token}`, "content-type": "application/json" });
const key = (await fetch(`${host().origin}/desk/history`, { headers: hdr() }).then((r) => r.json())).current.key;
const events = () => readFileSync(join(data, "projects", key, "w-dc.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const post = (body) => fetch(`${host().origin}/desk/decision`, { method: "POST", headers: hdr(), body: JSON.stringify({ session: "w-dc", ...body }) });
const seqs = (id) => events().filter((e) => e.type === "tool_call_end" && e.callId === id).map((e) => e.seq);
const card = () => app.count("[data-kind=decision-card]");
const picks = () => events().filter((e) => e.type === "user_input" && e.via?.kind === "choice");

// the pure function over a table of logs
const { liveCard } = await import("../../dist/shared/decision.js");
const R = { seq: 3, type: "tool_result", callId: "k", invocationSeq: 2, content: "x", isError: false, tags: ["end-turn"] };
const C = { seq: 2, type: "tool_call_end", callId: "k", name: "finish_with_choices", input: { choices: ["a", "b"] } };
const T = { seq: 4, type: "terminal", outcome: { kind: "completed" } };
const live = (...ev) => liveCard(ev) !== null;
check(live(C, R, T) && !live(C, R) && !live(C, { ...R, isError: true }, T) && !live(C, { ...R, tags: [] }, T) && !live(C, R, { ...T, outcome: { kind: "aborted" } }), "liveness: a successful END_TURN result and a completed terminal, nothing less");
check(!live(C, R, T, { seq: 5, type: "user_input", content: "x" }) && !live(C, R, { seq: 4, type: "stop", reason: "end_turn" }, T) && !live({ ...C, input: { choices: ["a"] } }, R, T) && liveCard([C, R, T]).recommended === true, "liveness: an input or a later model request overtakes it; one choice is no card; recommended defaults to true");

await app.evaluate(`window.__kiso.send("export?")`);
check(await waitUntil(async () => (await card()) === 1, 20_000), "the turn ends and the card hangs under the final message");
check((await app.count(".dc-pri")) === 1 && (await app.count("[data-act=choice]")) === 2 && (await app.text(".dc-pri kbd")) === "⌘↩", "two buttons, the recommended first and dark, with ⌘↩");
check((await app.count("[data-tool=finish_with_choices]")) === 0 && (await app.evaluate(`(() => { const c = document.querySelector(".turn .dcard"), f = document.querySelector(".turn [data-kind=footer]"); return !!c && !!f && !!(c.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING); })()`)) === true, "the call draws no step row, and the card sits inside its turn, above the footer");
const log = events();
const at = log.findIndex((e) => e.type === "tool_result" && e.callId === "c1");
check(log[at].tags?.includes("end-turn") && !log.slice(at).some((e) => e.type === "stop" || e.type === "text_delta") && log.at(-1).outcome?.kind === "completed", "F4: after the call's result no model request is made, and the run completed");
await app.shot("decision-card");
await app.evaluate(`location.reload()`);
await waitUntil(async () => (await app.count(".hlist .item")) >= 1, 20_000);
await app.evaluate(`document.querySelector(".hlist .item").click()`);
check(await waitUntil(async () => (await card()) === 1, 20_000), "opened cold, the Work draws the same card");
await app.click("[data-option='1']");
check(await waitUntil(() => picks().length === 1, 15_000) && picks()[0].content === "Keep CSV only" && picks()[0].via.invocationSeq === seqs("c1")[0] && picks()[0].via.option === 1, "a click appends the label as the person's line, marked as a pick (invocationSeq, option)");
check(await waitUntil(async () => (await card()) === 0 && /Kept CSV/.test((await app.text("body")) ?? ""), 15_000), "the card is gone and the next turn answers");

await app.evaluate(`window.__kiso.send("again")`);
await waitUntil(async () => (await card()) === 1, 20_000);
check((await app.count(".dc-pri")) === 0 && (await app.count("[data-act=choice]")) === 3 && (await app.count(".dcard kbd")) === 0, "recommended:false draws all choices equal and no shortcut");
await app.shot("decision-card-equal");
const forged = await post({ invocationSeq: seqs("c2")[0], option: 0, label: "EVIL" });
check(forged.status === 200 && (await waitUntil(() => picks().length === 2, 15_000)) && picks()[1].content === "Alpha", "a forged label is never read: the line is the model's own choices[option]");
check((await post({ invocationSeq: seqs("c2")[0], option: 1 })).status === 409, "a second click on the same card is 409, and sends nothing");
await waitUntil(async () => /Alpha taken/.test((await app.text("body")) ?? ""), 15_000);

await app.evaluate(`window.__kiso.send("third")`);
await waitUntil(async () => (await card()) === 1, 20_000);
await app.evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }))`);
check(await waitUntil(() => picks().length === 3, 15_000) && picks()[2].content === "One", "⌘↩ takes the recommended choice");
await waitUntil(async () => /One taken/.test((await app.text("body")) ?? ""), 15_000);

await app.evaluate(`window.__kiso.send("fourth")`);
await waitUntil(async () => (await card()) === 1, 20_000);

check((await app.evaluate(`[...document.querySelectorAll("[data-act=choice]")].map((b) => b.textContent).join("|")`)).startsWith("Five") && seqs("c1").length === 2, "a callId repeated across two runs: the card shows the NEW call's choices (the identity is the call's seq)");
const old = await post({ invocationSeq: seqs("c1")[0], option: 0 }); // the old card's identity, while a newer card with the same callId is live
check(old.status === 409 && picks().length === 3, "a stale click on the old card is 409 and never lands on the newer same-callId card");
await app.evaluate(`window.__kiso.send("never mind")`);
check(await waitUntil(async () => (await card()) === 0, 15_000), "a typed line overtakes the card");
const stale = await post({ invocationSeq: seqs("c1")[1], option: 0 });
await sleep(300);
check(stale.status === 409 && picks().length === 3, "a click on the overtaken card is 409 and sends nothing");
await app.shot("decision-card-superseded");
await app.close();

// R-SIB: a writing call in the SAME batch as finish_with_choices still runs (END_TURN fires after the batch settles), and the card shows
const ws2 = scratch("dc2-ws");
const sib = await launchApp({ data: scratch("dc2-data"), workspace: ws2, env: { KISO_WEB_SESSION: "w-sib", KISO_WEB_MODE: "full-access" }, fauxScript: [{ events: [{ type: "tool_call_end", callId: "f1", name: "finish_with_choices", input: { choices: ["Keep", "Delete"] } }, { type: "tool_call_end", callId: "w1", name: "shell", input: { command: "echo written > sibling.txt" } }, { type: "stop", reason: "tool_use" }] }] });
await sib.evaluate(`window.__kiso.send("batch")`);
check(await waitUntil(async () => (await sib.count("[data-kind=decision-card]")) === 1, 20_000) && existsSync(join(ws2, "sibling.txt")), "R-SIB: the writing call batched with the finish ran before the turn ended, and the card is shown (the description asks the model to call it alone)");
await sib.close();
verdict();
