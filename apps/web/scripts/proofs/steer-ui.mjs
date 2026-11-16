// ADR-0062 PR 5b (S3, S4; mocks 5 and 2): while an approval waits, a message from another Work shows as "Message from X · read
// after your answer", never in the box; the box reads "Typing declines this, and your words become the next instruction"; a
// typed line declines the approval and is admitted once, after the decline, with the waiting message. Screenshots go outside.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("steer-ui");
const ok = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const call = (callId, name, input) => ({ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] });
const data = scratch("steer-data");
const app = await launchApp({
	data,
	workspace: scratch("steer-ws"),
	env: { KISO_WEB_SESSION: "w-main", KISO_WEB_SESSIONS: "on", KISO_WEB_MODE: "default" },
	fauxScript: [ok, ok, call("w1", "shell", { command: "npm install" }), call("m1", "message", { to: "Importer", text: "Version 3 of the schema is final." }), ok, ok, ok],
});
const q = (js) => app.evaluate(js);
const host = () => app.host();
const key = (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).current.key;
const log = (id) => readFileSync(join(data, "projects", key, `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const idle = async (id) => (await waitUntil(async () => !(await clientFor(host()).session(id).state()).running, 15_000), await sleep(500));

await clientFor(host()).session("w-main").run("Importer");
await idle("w-main");
await clientFor(host()).session("w-res").run("Research");
await idle("w-res");
await q(`window.__kiso.send("Install the dependencies and run the importer.")`);
await waitUntil(async () => (await app.count("[data-kind=ask]")) === 1, 15_000);
await clientFor(host()).session("w-res").run("tell the importer");
await waitUntil(async () => (await app.count("[data-kind=waiting-row]")) === 1, 15_000);
check((await app.text("[data-kind=waiting-row] .prow-head"))?.replace(/\s+/g, " ").startsWith("Message from Research · read after your answer") === true, "a message waiting behind an approval: Message from Research · read after your answer");
// the hint is whole when it fits the box, else its short form; never cut (the overview open makes the box narrow)
const hint = () => q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); const c = document.createElement('canvas').getContext('2d'); c.font = getComputedStyle(el).font; return { text: el.placeholder, fits: c.measureText(el.placeholder).width <= el.clientWidth }; })()`);
const narrow = await hint();
check(narrow.text === "Typing declines this" && narrow.fits, "narrow: the short hint, whole");
await app.shot("pr5b-5-decline-narrow");
await app.cdp("Emulation.setDeviceMetricsOverride", { width: 1500, height: 760, deviceScaleFactor: 1, mobile: false });
await sleep(400);
const wide = await hint();
check(wide.text === "Typing declines this, and your words become the next instruction" && wide.fits, "wide: the whole hint, as mock 5 has it");
await app.shot("pr5b-5-decline-wide");
await app.cdp("Emulation.clearDeviceMetricsOverride", {});
await q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); el.focus(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'Skip the notes, use the schema doc instead.'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await q(`document.querySelector('[data-kind=composer] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
await idle("w-main");
const events = log("w-main");
const decided = events.findIndex((e) => e.type === "permission_decided" && e.decision !== "approved");
const line = events.findIndex((e) => e.type === "user_input" && e.content === "Skip the notes, use the schema doc instead.");
check(decided >= 0 && line > decided && events.filter((e) => e.type === "user_input" && e.content === "Skip the notes, use the schema doc instead.").length === 1, "the approval is declined, and the line is admitted once, after it");
check(events.some((e) => e.type === "user_input" && e.via?.kind === "peer"), "the waiting message is admitted too");
await waitUntil(async () => (await app.count("[data-kind=waiting-row]")) === 0, 10_000);
check((await app.count("[data-kind=waiting-row]")) === 0, "once read, the waiting row gives way to the message's own row");
await app.close();
verdict();
