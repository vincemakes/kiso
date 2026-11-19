// ADR-0062 PR 4, the page (mocks 1 and 1b): a started Work is one line "Started <title> ›" in its parent, nested under it in the
// sidebar, and opens on "Started from <parent> · <folder>" with the brief as its first message; a named Work is a card (New Work,
// the title, two lines of the brief, ×, Do it here, Start) and Start opens the new Work. Screenshots go outside the repository.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("start-ui");
const okay = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const start = (callId, input) => ({ events: [{ type: "tool_call_end", callId, name: "start_session", input }, { type: "stop", reason: "tool_use" }] });
const brief = "Fix the CSV export of invoices: totals are wrong when a credit note is attached. Reproduce it with the fixture in tests/export/credit-note.csv, find the cause in src/export/totals.ts, and fix it. Do not change the invoice schema. Deliverable: a passing test.";
const app = await launchApp({
	data: scratch("start-ui-data"),
	workspace: scratch("start-ui-ws"),
	env: { KISO_WEB_SESSION: "pay", KISO_WEB_SESSIONS: "on" },
	fauxScript: [start("s1", { title: "Payment fixes", brief: "Fix the payment retries.", initiation: "asked" }), okay, okay, okay, start("s2", { title: "Fix the invoice export", brief, initiation: "named" }), okay, okay, okay],
});
const q = (js) => app.evaluate(js);
await q(`window.__kiso.send("Put the payment fixes in a session of their own, and carry on here with the importer.")`);
await waitUntil(async () => (await app.count("[data-kind=started-work]")) === 1, 30_000);
await sleep(1500); // the child's first turn and its report back take their requests
await q(`window.__kiso.send("The invoice export is broken too.")`);
await waitUntil(async () => (await app.count("[data-kind=work-card]")) === 1, 30_000);
await waitUntil(async () => (await app.count("[data-kind=started-work] b")) === 1 && (await app.count(".item.child")) >= 1, 15_000).catch(() => undefined);
check((await app.text("[data-kind=started-work]"))?.includes("Payment fixes") === true, "the asked Work is one line in its parent: Started Payment fixes");
check((await app.count(".item.child")) >= 1, "the started Work is nested under its parent in the sidebar");
check((await app.text("[data-kind=work-card] .wcard-body b")) === "Fix the invoice export" && (await app.count("[data-act=card-here]")) === 1 && (await app.count("[data-act=card-start]")) === 1 && (await app.count("[data-act=card-dismiss]")) === 1, "the named Work is a card: its title, Do it here, Start and ×");
check((await q(`getComputedStyle(document.querySelector("[data-kind=work-card] p")).webkitLineClamp`)) === "2", "the brief shows two lines at most");
await app.shot("pr4-1-start-session");
await q(`document.querySelector(".scroll").scrollTop = 0`);
await sleep(300);
await app.shot("pr4-1-start-session-top");
await app.click("[data-act=card-start]");
await waitUntil(async () => (await app.count("[data-kind=started-from]")) === 1, 30_000);
check((await app.text("[data-kind=started-from]"))?.startsWith("Started from") === true && (await app.count("[data-act=started-parent]")) === 1, "Start opens the new Work on 'Started from <parent> · <folder>', the parent a link");
check((await q(`(() => { const n = document.querySelector("[data-kind=started-from]"); return n.getBoundingClientRect().height < 24 && getComputedStyle(n.querySelector(".flink")).textOverflow === "ellipsis"; })()`)) === true, "a long parent title keeps the line to one: the title is cut with an ellipsis, the folder stays whole");
await waitUntil(async () => (await q(`[...document.querySelectorAll(".me")].some((m) => m.textContent.includes("credit note"))`)) === true, 15_000);
check(true, "its first message is the brief");
await sleep(500);
await app.shot("pr4-1b-started-work");
await app.close();
verdict();
