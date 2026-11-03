// A Work titles itself from its first message (plan session-title rev 2, owner 2026-11-03): the host asks the Work's own
// model through Session.title beside the first run and writes the name while the Work is still unnamed; the sidebar row
// and the header show it; a later message asks nothing again. The title request and the run's go out together, so the
// faux script answers both the same: whichever takes which, the run's answer and the title are known.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("session-title");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("st-data");
const app = await launchApp({ data, workspace: scratch("st-ws"), fauxScript: [say("Ledger fix"), say("Ledger fix"), say("Done.")], env: { KISO_WEB_SESSION: "st", KISO_AUTO_TITLE: "on" } });
const q = (js) => app.evaluate(js);
await q(`window.__kiso.send("npm test fails because the ledger subtracts wrong, can you fix it?")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
const row = () => q(`document.querySelector('.item[data-work="st"] .tt')?.textContent ?? ''`);
check(await waitUntil(async () => (await row()) === "Ledger fix", 20_000), `the sidebar row shows the title made from the first message, not the message ("${await row()}")`);
check(await waitUntil(async () => (await app.text("[data-field=title]")) === "Ledger fix", 15_000), "the header shows it too");
const dir = join(data, "projects", readdirSync(join(data, "projects"))[0]);
check(JSON.parse(readFileSync(join(dir, "st.meta.json"), "utf8")).name === "Ledger fix", "it is the Work's name, where the terminal's rename keeps one");
await q(`window.__kiso.send("and add a test")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 30_000);
const purposes = readFileSync(join(dir, "traces", "st.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.kind === "request").map((l) => l.purpose ?? "run");
check(purposes.filter((p) => p === "title").length === 1 && purposes.filter((p) => p === "run").length === 2, `one title for the Work: the second message asks nothing again (${purposes.join()})`);
await app.close();
verdict();
