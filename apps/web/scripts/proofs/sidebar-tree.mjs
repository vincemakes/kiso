// Delegated children (ADR-0032: `sub-<parent>-…-<n>-<role>` sessions in the parent's folder) list under their parent, one step
// in, each with its role (plan sidebar-rebuild A, owner 2026-11-03). A parent's ▾ folds them and, folded, counts them; one with
// more than five starts folded; the fold stands through a reload; archiving the parent takes its children with it.
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("sidebar-tree");
const data = scratch("tree-data");
const turn = { events: [{ type: "text_delta", text: "Delegated." }, { type: "stop", reason: "end_turn" }] };
const app = await launchApp({ data, workspace: scratch("tree-ws"), fauxScript: [turn], env: { KISO_WEB_SESSION: "tp" } });
const q = (js) => app.evaluate(js);
await q(`window.__kiso.send("Plan the work")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
// the delegations a run would have written: six children of tp, and a second Work tq with two
const dir = join(data, "projects", readdirSync(join(data, "projects"))[0]);
const log = (id, text, t) => writeFileSync(join(dir, `${id}.jsonl`), [{ type: "user_input", content: text, seq: 0 }, { type: "terminal", outcome: { kind: "completed" }, seq: 1 }].map((event) => JSON.stringify({ runId: id, ts: t, event })).join("\n") + "\n");
const now = Date.now();
log("tq", "Review the plan", now - 60_000);
for (const [i, role] of ["reviewer", "explorer"].entries()) log(`sub-tq-${i + 1}-${role}`, `Second ${role}`, now - 50_000);
for (let i = 1; i <= 6; i++) log(`sub-tp-4a1b2c3d4e5f6a7b8c9d0e1f-${i}-${i === 1 ? "reviewer" : "explorer"}`, `Child task ${i}`, now - 40_000 + i);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
const rows = () => q("[...document.querySelectorAll('.hlist .item[data-work]')].map((e) => (e.classList.contains('child') ? '└' : '') + e.dataset.work + (e.classList.contains('child') ? ':' + e.querySelector('small').textContent : ''))");
const count = (id) => q(`document.querySelector('[data-act=fold-kids][data-for="${id}"]')?.textContent ?? null`);
check(await waitUntil(async () => (await count("tp")) === "6" && (await rows()).filter((r) => r.startsWith("└sub-tp")).length === 0, 30_000), `a parent with six children starts folded and counts them (${await count("tp")})`);
check((await rows()).join().includes("tq,└sub-tq-1-reviewer:reviewer,└sub-tq-2-explorer:explorer"), `one with two lists them under it with their roles (${(await rows()).join(" ")})`);
await q(`document.querySelector('[data-act=fold-kids][data-for="tp"]').click(); true`);
const open = await waitUntil(async () => (await rows()).filter((r) => r.startsWith("└sub-tp")).length === 6 && (await count("tp")) === "");
await app.shot("sidebar-tree");
await q("location.reload()");
await sleep(1500);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
check(open && (await waitUntil(async () => (await rows()).filter((r) => r.startsWith("└sub-tp")).length === 6, 20_000)), "its ▾ shows the six, and the choice stands through a reload");
const res = await fetch(`${app.host().origin}/desk/work`, { method: "POST", headers: { authorization: `Bearer ${app.host().token}` }, body: JSON.stringify({ session: "tp", act: "archive" }) });
await q("location.reload()");
await sleep(1500);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
check(res.status === 200 && (await waitUntil(async () => (await rows()).length > 0 && !(await rows()).some((r) => r.includes("sub-tp") || r === "tp"), 20_000)), "archiving the parent takes its children out of the list with it");
await app.close();
verdict();
