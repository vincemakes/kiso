// Deleting a Work that has nested sessions (owner 2026-11-18): the dialog counts them (this folder's) and offers "Delete this session"
// (they move up; a grandchild stays under its own parent) or "Delete all N sessions" (the whole tree or nothing: a running member refuses all of it).
// A completion notice for a deleted parent is dropped, not written; if a deleted Work's inbox ever comes back, the failure names each
// file in it, its time and its sender (inboxOf). Hand-made Works over a seed run.
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep, clientFor } from "./lib.mjs";

const { check, verdict } = checker("delete-tree"); const inboxOf = (id) => { const d = join(dir, `${id}.inbox`); if (!existsSync(d)) return ""; return ` | ${id}.inbox: ` + readdirSync(d).map((f) => { const p = join(d, f); let from = ""; try { from = JSON.parse(readFileSync(p, "utf8")).from ?? ""; } catch {} return `${f} @${new Date(statSync(p).mtimeMs).toISOString()} from ${from}`; }).join("; "); }; const data = scratch("dt-data"); const say = (text, ms = 0) => ({ events: [{ type: "delay", ms }, { type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const app = await launchApp({ data, workspace: scratch("dt-ws"), env: { KISO_WEB_SESSION: "w-seed", KISO_WEB_SESSIONS: "on" }, fauxScript: [say("done", 2500), say("done", 2500)] });
await app.evaluate(`window.__kiso.send("seed")`); await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
// the seed log is copied only once its run has ended (a slow machine writes the terminal late)
const key = readdirSync(join(data, "projects"))[0], dir = join(data, "projects", key); const ended = (id) => existsSync(join(dir, `${id}.jsonl`)) && readFileSync(join(dir, `${id}.jsonl`), "utf8").split("\n").filter((l) => l.includes('"type":"terminal"')).length; await waitUntil(async () => ended("w-seed") === 1, 30_000); const top = Math.max(...readFileSync(join(dir, "w-seed.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event.seq));
const make = (id, by, title) => { copyFileSync(join(dir, "w-seed.jsonl"), join(dir, `${id}.jsonl`)); writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "w-seed.meta.json"), "utf8")), name: title, sessionsTools: true, ...(by === null ? {} : { startedBy: by, forkedFrom: { session: by.slice(key.length + 1), afterSeq: top, at: 1, title: "x" } }) })); };
for (const [id, by, title] of [["wp", null, "Parent"], ["wa", `${key}/wp`, "Child A"], ["wb", `${key}/wp`, "Child B"], ["wg", `${key}/wa`, "Grandchild"], ["wu", null, "Alone"]]) make(id, by, title);
// a child's finished run wakes its parent and so on up the tree: wait until no Work of the tree runs and their logs stop changing (a slow machine is late)
const settle = async () => { let last = ""; for (let i = 0; i < 40; i++) { await sleep(1500); const ids = ["wp", "wa", "wg"].filter(have), now = ids.map((id) => statSync(join(dir, `${id}.jsonl`)).size).join(); if (now === last && !(await Promise.all(ids.map((id) => clientFor(app.host()).session(id).state()))).some((x) => x.running)) return; last = now; } };
const have = (id) => ["jsonl", "meta.json"].every((e) => existsSync(join(dir, `${id}.${e}`))); const desk = (body) => fetch(`${app.host().origin}/desk/work`, { method: "POST", headers: { authorization: `Bearer ${app.host().token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));
const reload = async () => { await app.restart(); await app.evaluate("location.reload()"); await waitUntil(async () => (await app.count(".hlist .item")) >= 5, 20_000); await sleep(800); };
const rows = () => app.evaluate("JSON.stringify([...document.querySelectorAll('.hlist .item')].map((e) => (e.classList.contains('child') ? '└' : '') + e.dataset.work))").then(JSON.parse);
const ask = async (id) => { await app.evaluate(`document.querySelector('[data-act=work-menu][data-for="${id}"]').click()`); await waitUntil(async () => (await app.count("[data-kind=work-menu]")) === 1); await app.evaluate("document.querySelector('[data-menu-act=delete]').click()"); await waitUntil(async () => (await app.count("[data-kind=delete-dialog]")) === 1, 5000); };
await reload(); await ask("wp");
check((await app.text("[data-kind=delete-what]")).includes("has 3 nested sessions") && /This cannot be undone.*Files they changed in the folder stay|Files they changed in the folder stay.*This cannot be undone/.test(await app.text("[data-kind=delete-what]")) && (await app.text("[data-act=delete-alt]")) === "Delete all 4 sessions" && (await app.text("[data-act=delete-confirm]")) === "Delete this session", "a Work with nested sessions: the count is this folder's tree (a grandchild counts), two buttons");
await app.shot("delete-tree-dialog"); await app.click("[data-act=delete-cancel]"); await ask("wu");
check((await app.count("[data-act=delete-alt]")) === 0 && (await app.text("[data-act=delete-confirm]")) === "Delete", "a Work without nested sessions: today's dialog, one confirm");
// a running member refuses the whole tree, in words, and every file stays
await app.click("[data-act=delete-cancel]"); const g = clientFor(app.host()).session("wg"), run = g.run("go"); await sleep(1200); const busy = await desk({ session: "wp", act: "delete-tree" });
check(busy.status === 409 && /Grandchild.*while it is running.*Nothing was deleted/.test(busy.message) && ["wp", "wa", "wb", "wg"].every(have), `a running member refuses the whole tree and names it: nothing is removed (${busy.status} ${busy.message})`);
await run; await settle(); // only the parent: the children stand on their own, the grandchild stays under its parent; a later notice for the gone parent is dropped
await ask("wp"); await app.click("[data-act=delete-confirm]"); await waitUntil(async () => !have("wp"), 10_000); await reload();
await clientFor(app.host()).session("wa").run("again"); await settle(); const left = await rows();
check(left.join() !== "" && !left.includes("└wa") && !left.includes("└wb") && left.includes("wa") && left.includes("wb") && left.includes("└wg") && have("wa") && have("wg") && !readdirSync(dir).some((f) => f.startsWith("wp.")), `deleting only the parent: its children are top-level, the grandchild stays under its parent, nothing of the parent is made again after a child's run (${left} | ${readdirSync(dir).filter((f) => f.startsWith("wp"))}${inboxOf("wp")})`);
// the whole tree: gone from the list and from the disk
await ask("wa"); await app.click("[data-act=delete-alt]"); await waitUntil(async () => !have("wa") && !have("wg"), 10_000);
const [list, disk] = [await rows(), readdirSync(dir).filter((f) => /^w[ag]\./.test(f))];
check(!have("wa") && !have("wg") && have("wb") && !list.some((r) => r.endsWith("wa") || r.endsWith("wg")) && disk.length === 0, `Delete all removes the Work and what is nested under it, list and disk, and nothing else (${list} | ${disk})`);
await app.close(); verdict();
