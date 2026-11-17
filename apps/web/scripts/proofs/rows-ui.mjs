// ADR-0062 PR 5a, the page (mocks 2 and 2b): messages between Works as default-collapsed rows. The sender shows "Messaged
// @Research <text…>"; the receiver "Received message from Research", its text only when opened; messages admitted together are
// one "Received 3 messages" row; a child's completion is "<child> finished". Never the raw text the model reads. Screenshots
// go outside the repository.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("rows-ui");
const ok = { events: [{ type: "text_delta", text: "Ok." }, { type: "stop", reason: "end_turn" }] };
const send = (callId, to, text) => ({ events: [{ type: "tool_call_end", callId, name: "message", input: { to, text } }, { type: "stop", reason: "tool_use" }] });
const data = scratch("rows-data");
const app = await launchApp({
	data,
	workspace: scratch("rows-ws"),
	env: { KISO_WEB_SESSION: "w-main", KISO_WEB_SESSIONS: "on" },
	fauxScript: [ok, ok, send("m1", "Research", "Which schema version does the importer target? The API doc is at docs/api.md and it lists two."), ok, ok, send("m2", "Importer", "Version 3. The importer should target it."), ok, ok, send("m3", "Importer", "The docs are updated."), ok, ok, ok, ok, send("m4", "Importer", "Version 3 of the schema is final. Please regenerate the client."), ok, ok, ok, ok],
});
const host = () => app.host();
const q0 = (js) => app.evaluate(js);
const key = (await fetch(`${host().origin}/desk/history`, { headers: { authorization: `Bearer ${host().token}` } }).then((r) => r.json())).current.key;
const dir = join(data, "projects", key);
const idle = async (...ids) => (await waitUntil(async () => (await Promise.all(ids.map(async (id) => (await clientFor(host()).session(id).state()).running))).every((r) => !r), 15_000), await sleep(800));
const run = async (id, text) => (await clientFor(host()).session(id).run(text), await idle(id));
const all = ["w-main", "w-res", "w-doc"];

await run("w-res", "Research");
await run("w-doc", "Docs");
await run("w-main", "Importer");
await idle(...all);
await run("w-res", "answer the importer");
await idle(...all);
mkdirSync(join(dir, "w-main.inbox"), { recursive: true });
for (const [n, text] of [[1, "First of two written while it was idle."], [2, "Second of two."]]) writeFileSync(join(dir, "w-main.inbox", `pre${n}.json`), JSON.stringify({ messageId: `pre${n}`, from: `${key}/w-res`, fromTitle: "Research", text, files: [], rootId: `${key}/w-res#0`, at: n }));
await run("w-doc", "tell the importer");
await idle(...all);
writeFileSync(join(dir, "w-kid.meta.json"), JSON.stringify({ startedBy: `${key}/w-main` }));
await run("w-kid", "Payment fixes");
await idle("w-kid", "w-main");
await waitUntil(async () => (await app.count("[data-kind=peer-group]")) === 1 && (await app.count("[data-kind=peer-row]")) >= 3, 15_000).catch(() => undefined);
const heads = await app.evaluate(`[...document.querySelectorAll("[data-kind=peer-row] > .prow-head, [data-kind=peer-group] > .prow-head")].map((h) => h.textContent.replace(/\\s+/g, " ").trim())`);
check(heads.some((h) => h.startsWith("Messaged @Research Which schema version")), "the sender's row: Messaged @Research and the text's opening");
check(heads.some((h) => h.startsWith("Received message from Research")), "the receiver's row: Received message from Research");
check(heads.some((h) => h.startsWith("Received 3 messages")), "three messages admitted together are one row");
check(heads.some((h) => /^Payment fixes finished/.test(h)), "a child's completion: Payment fixes finished");
check((await app.evaluate(`document.body.innerText.includes("Message from the session") || document.body.innerText.includes("which this session started")`)) === false, "the raw text the model reads is never drawn");
check((await app.count(".prow-body")) === 0, "every row starts collapsed");
await app.click("[data-kind=peer-group] > .prow-head");
await sleep(300);
check((await app.count("[data-kind=peer-group] .pgroup [data-kind=peer-row]")) === 3, "opened, the group lists each message");
await app.shot("pr5a-2-rows");
await q0(`document.querySelector(".scroll").scrollTop = 0`);
await sleep(300);
await app.shot("pr5a-2-rows-top");
await app.evaluate(`(() => { const h = [...document.querySelectorAll("[data-kind=peer-row] > .prow-head")].find((h) => h.textContent.includes("Received message from")); h?.click(); h?.scrollIntoView({ block: "start" }); })()`);
await sleep(300);
check((await app.evaluate(`[...document.querySelectorAll(".prow-body")].map((b) => b.textContent)`)).some((t) => t === "Version 3. The importer should target it."), "opened, a message shows its text only");
await app.shot("pr5a-2b-row-opened");
check(readFileSync(join(dir, "w-main.jsonl"), "utf8").includes('"kind":"peer"'), "the rows are drawn from the events' own via");
// the hold (mock 2c): the Importer is given a folder the Docs Work lacks, so its message waits for the person
writeFileSync(join(dir, "w-main.environment.json"), `${JSON.stringify({ version: 1, added: [scratch("rows-extra")] })}\n`);
await run("w-doc", "send the schema news");
await waitUntil(async () => (await app.count("[data-kind=held-row]")) === 1, 15_000);
check((await app.text("[data-kind=held-row] .prow-head"))?.replace(/\s+/g, " ").startsWith("Message from Docs · held") === true && (await app.count("[data-act=held-admit]")) === 1 && (await app.count("[data-act=held-drop]")) === 1, "a held message: Message from Docs · held, with Drop and Admit");
await q0(`document.querySelector("[data-kind=held-row]").scrollIntoView({ block: "center" })`);
await app.shot("pr5a-2c-held-message");
await app.click("[data-act=held-admit]");
await waitUntil(async () => (await app.count("[data-kind=held-row]")) === 0, 15_000);
await idle("w-main");
check(readFileSync(join(dir, "w-main.jsonl"), "utf8").includes("regenerate the client"), "Admit delivers it: the Importer reads it");
// § 14 test 23: the rows drawn live, on a cold open (a new tab replays the whole log) and after a reconnect (the host killed and
// started again; the tab picks up) are the same rows, from the same senders
// (each row as it reads closed: a row opened above shows ⌄ and a group lists its rows, neither of which a fresh tab has)
const rows = (tab) => tab.evaluate(`[...document.querySelectorAll(".prow-head")].filter((h) => !h.closest(".pgroup")).map((h) => h.closest("[data-kind]").dataset.kind + " " + h.textContent.replace(/[›⌄]/g, "").replace(/\\s+/g, " ").trim()).join("\\n")`);
const live = await rows(app);
const cold = await app.chrome.open(`${host().origin}/#session=w-main`);
await waitUntil(async () => (await rows(cold)) === live, 15_000);
check((await rows(cold)) === live && live.split("\n").length >= 5, "a cold open draws the same rows as the live stream did");
await cold.close();
await app.restart();
await run("w-main", "One more."); // made after the restart: the tab draws it only once it has reconnected
await waitUntil(async () => (await app.evaluate(`[...document.querySelectorAll(".me")].some((m) => m.textContent.includes("One more."))`)) === true, 20_000);
check((await app.evaluate(`[...document.querySelectorAll(".me")].some((m) => m.textContent.includes("One more."))`)) === true && (await rows(app)) === live, "reconnected after the host restarts (it draws a run made since), the same rows");
await app.close();
verdict();
