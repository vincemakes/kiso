// ADR-0062 § 10b with titles on (F15): a first line taken back takes the title made from it, and the next line names the Work.
// The title request and the run share the scripted model; the title asks first, so the run's own reply comes second.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("rewind-title");
const say = (text, ms = 0) => ({ events: [...(ms > 0 ? [{ type: "delay", ms }] : []), { type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("rwt-data");
const app = await launchApp({ data, workspace: scratch("rwt-ws"), env: { KISO_WEB_SESSION: "w", KISO_AUTO_TITLE: "on" }, fauxScript: [say("Typo title"), say("never", 6000), say("Fixed title"), say("Green.")] });
const q = (js) => app.evaluate(js);
const key = (await fetch(`${app.host().origin}/desk/history`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json())).current.key;
const name = () => ((p) => (existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")).name ?? null) : null))(join(data, "projects", key, "w.meta.json"));

await q(`window.__kiso.send("Waht colour is thsi image?")`);
check(await waitUntil(() => name() === "Typo title", 10_000), "the first line names the Work");
await q(`window.__kiso.abort()`).then(() => waitUntil(async () => (await q(`window.__kiso.state.turns.at(-1)?.phase`)) === "ended", 15_000));
await waitUntil(async () => (await q(`document.querySelector("[data-act=rewind]")?.disabled`)) === false, 10_000).then(() => app.click("[data-act=rewind]"));
check(await waitUntil(() => name() === null, 5_000), "taking that line back takes its title with it");
await sleep(300).then(() => q(`window.__kiso.send("What colour is this image?")`));
check(await waitUntil(() => name() === "Fixed title", 10_000), `the next line names the Work (now: ${JSON.stringify(name())})`);
await app.close();
verdict();
