// The sidebar's per-Work ⋯ menu (plan PR 7, owner 2026-11-02; reworked to the owner's reference 2026-11-03). It opens on ⋯, lists
// Open PR first and a key on each item, picks on that key, and closes on a click away or Esc. Pin puts the one row under Pinned (its
// forks stay below), the latest pin first, through a reload; a group's head folds it; Rename works in the row (its text selected, no box); Fork opens a fork listed
// under its parent; Open PR shows only when the folder's branch has an open one; Archive takes a Work and its forks out of the list
// and "Archived (n)" brings it back. Delete is refused while the Work runs, names what goes, then removes its log, sidecar and task
// records and its entries in desktop.json; its fork becomes a top-level row. Screenshots go outside the repository.
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("sidebar-menu");
const ID = { GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@x" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ID } }).trim();
const [origin, ws, bin] = [scratch("menu-origin"), scratch("menu-ws"), scratch("menu-bin")];
git(origin, "init", "-q", "--bare", "-b", "main");
git(ws, "init", "-q", "-b", "main");
writeFileSync(join(ws, "a.txt"), "one\n");
git(ws, "add", ".");
git(ws, "commit", "-qm", "base");
git(ws, "remote", "add", "origin", origin);
git(ws, "push", "-q", "origin", "main");
git(ws, "remote", "set-head", "origin", "main");
git(ws, "checkout", "-qb", "feat/menu");
writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n"auth status") exit 0 ;;\n"pr view") echo '{"number":7,"title":"Menu","url":"https://example.invalid/pull/7","state":"OPEN","statusCheckRollup":[]}' ;;\n*) exit 1 ;;\nesac\n`);
chmodSync(join(bin, "gh"), 0o755);
const slow = { events: [...Array.from({ length: 20 }, (_, i) => [{ type: "text_delta", text: `a${i} ` }, { type: "delay", ms: 100 }]).flat(), { type: "stop", reason: "end_turn" }] };
const turn = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("menu-data");
const app = await launchApp({ data, workspace: ws, fauxScript: [slow, turn("Bravo."), turn("Fork.")], env: { PATH: `${bin}:${process.env.PATH}`, KISO_WEB_SESSION: "wa", ...ID } });
const q = (js) => app.evaluate(js);
const desk = (path, body) => fetch(`${app.host().origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${app.host().token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const dir = () => join(data, "projects", readdirSync(join(data, "projects"))[0]);
const rows = () => q("[...document.querySelectorAll('.hlist .grp, .hlist .item')].map((e) => e.classList.contains('grp') ? '#' + e.textContent : (e.classList.contains('child') ? '└' : '') + (e.dataset.work ?? 'input'))");
const menu = async (id) => (await q(`document.querySelector('[data-act=work-menu][data-for="${id}"]').click(); true`), await waitUntil(async () => (await app.count("[data-kind=work-menu]")) === 1));
const pick = (act) => q(`document.querySelector('[data-menu-act=${act}]').click(); true`);

// a running Work cannot be deleted or archived
await q(`window.__kiso.send("Alpha task")`);
await sleep(300);
const [del, arc] = [await desk("/desk/work", { session: "wa", act: "delete" }), await desk("/desk/work", { session: "wa", act: "archive" })];
check(del.status === 409 && /cannot be deleted while it is running/.test(del.message) && arc.status === 409, `a running Work is refused in words ("${del.message}")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
await app.click("[data-act=new]");
await sleep(400);
await q(`window.__kiso.send("Bravo task")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1 && (await app.text(".ans")) === "Bravo.", 30_000);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count(".item[data-work]")) === 2, 20_000);
const wb = await q("[...document.querySelectorAll('.item[data-work]')].map((e) => e.dataset.work).find((w) => w !== 'wa')");

// the menu opens and closes
await menu("wa");
await waitUntil(async () => (await app.count("[data-menu-act=pr]")) === 1, 10_000);
await app.shot("sidebar-menu-0");
const items = await q("[...document.querySelectorAll('[data-menu-act]')].map((e) => e.dataset.menuAct).join()");
const keys = await q("[...document.querySelectorAll('[data-menu-act] kbd')].map((e) => e.textContent).join('')");
const icons = await q("document.querySelectorAll('[data-kind=work-menu] svg').length");
await q("document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true");
const away = await waitUntil(async () => (await app.count("[data-kind=work-menu]")) === 0, 3000);
await menu("wa");
await q("dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
const esc = await waitUntil(async () => (await app.count("[data-kind=work-menu]")) === 0, 3000);
check(items === "pr,link,pin,rename,fork,archive,delete" && keys === "GLPRFAD" && icons === 0 && away && esc, `the menu lists Open PR (the branch has #7) first, then link a PR, pin, rename, fork, archive and delete, each with its key and no icon, and closes on a click away and on Esc (${items} ${keys})`);

// pin: the latest pin first, through a reload
await menu("wa"), await pick("pin");
await waitUntil(async () => (await rows())[0] === "#Pinned");
await menu(wb), await pick("pin");
check(await waitUntil(async () => (await rows()).slice(0, 3).join() === `#Pinned,${wb},wa`), `pinned Works list first, the latest pin first (${(await rows()).join(" ")})`);
await q("location.reload()");
await sleep(1500);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
check(await waitUntil(async () => (await rows()).slice(0, 3).join() === `#Pinned,${wb},wa`, 20_000), "the pins stand through a reload (the host's own desktop.json)");
check((await app.count(".pinmark")) === 0, "a pinned row carries no pin mark: the Pinned head says it");
await app.click("[data-act=fold-group]");
const folded = await waitUntil(async () => (await rows()).join() === "#Pinned");
await q("location.reload()");
await sleep(1500);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
const kept = await waitUntil(async () => (await rows()).join() === "#Pinned", 20_000);
await app.click("[data-act=fold-group]");
check(folded && kept && (await waitUntil(async () => (await rows()).slice(0, 3).join() === `#Pinned,${wb},wa`)), "the Pinned head folds its rows, the fold stands through a reload, and opens again");
await menu(wb);
await q("dispatchEvent(new KeyboardEvent('keydown', { key: 'p' })); true");
check(await waitUntil(async () => (await rows()).slice(0, 2).join() === "#Pinned,wa" && (await app.count("[data-kind=work-menu]")) === 0), "P in the open menu unpins");

// rename in the row
await q(`document.querySelector('.item[data-work="${wb}"]').click(); true`);
await waitUntil(async () => (await app.count("[data-kind=header]")) === 1, 15_000);
await menu(wb), await pick("rename");
const look = () => q("(() => { const el = document.querySelector('[data-field=row-title-input]'); if (!el) return null; const c = getComputedStyle(el); return { all: el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0, border: c.borderTopWidth, focus: document.activeElement === el }; })()");
await waitUntil(async () => (await look())?.all === true);
const editing = await look();
const type = (v) => q(`(() => { const el = document.querySelector('[data-field=row-title-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true; })()`);
await type("Bravo, renamed");
check(editing.all && editing.focus && editing.border === "0px" && (await waitUntil(async () => (await app.text(`.item[data-work="${wb}"] .tt`)) === "Bravo, renamed" && (await app.text("[data-field=title]")) === "Bravo, renamed")), "Rename works in the row: its text selected, no box; Enter keeps it and the header agrees");

// fork from the menu, under its parent
await menu("wa"), await pick("fork");
check(await waitUntil(async () => (await app.count("[data-kind=fork-note]")) === 1, 20_000), "Fork opens a fork of the Work at once");
const fork = readdirSync(dir()).find((f) => f.endsWith(".jsonl") && ![`wa.jsonl`, `${wb}.jsonl`].includes(f)).slice(0, -6);
check(await waitUntil(async () => (await rows()).slice(0, 3).join() === "#Pinned,wa,#Recents" && (await rows()).includes(fork), 20_000), "a pin holds the one row: the fork of a pinned Work lists under Recents");

// archive: the Work and its fork leave the list; Archived (1) brings it back
await menu("wa"), await pick("archive");
check(await waitUntil(async () => !(await rows()).includes("wa") && !(await rows()).includes(`└${fork}`) && /Archived \(1\)/.test(await app.text("[data-act=archived]"))), "Archive takes the Work and its fork out of the list; the Archived line counts it");
await app.click("[data-act=archived]");
await waitUntil(async () => (await rows()).includes("wa"));
await menu("wa"), await pick("unarchive");
check(await waitUntil(async () => (await rows()).slice(0, 2).join() === "#Pinned,wa" && (await rows()).includes(fork) && (await app.count("[data-act=archived]")) === 0), "Unarchive puts it back, with its fork");
await menu("wa"), await pick("unpin");
check(await waitUntil(async () => (await rows()).join().includes(`wa,└${fork}`)), "unpinned, the fork is listed under its parent again");
await app.shot("sidebar-menu-1");

// delete: the dialog says what goes; then the files and the host's entries are gone; the fork stands on its own
await menu("wa"), await pick("delete");
await waitUntil(async () => (await app.count("[data-kind=delete-dialog]")) === 1);
const said = await app.text("[data-kind=delete-what]");
await app.shot("sidebar-menu-2");
const instant = await q("(async () => { document.querySelector('[data-act=delete-confirm]').click(); await null; return document.querySelectorAll('[data-kind=delete-dialog], .item[data-work=wa]').length; })()");
await waitUntil(async () => !existsSync(join(dir(), "wa.jsonl")) && !JSON.parse(readFileSync(join(data, "desktop.json"), "utf8")).pins?.includes("wa"), 10_000);
const desktop = JSON.parse(readFileSync(join(data, "desktop.json"), "utf8"));
const gone = ["wa.jsonl", "wa.meta.json", "wa.tasks"].every((f) => !existsSync(join(dir(), f)));
check(/conversation \(1 run\).*Files it changed in the folder stay/.test(said) && gone && ![...(desktop.pins ?? []), ...(desktop.archived ?? [])].includes("wa") && ["tiers", "works", "forks"].every((m) => !(m in desktop) || !("wa" in desktop[m])), `Delete names what goes ("${said.slice(0, 60)}…"), then removes the log, sidecar and task records and the host's entries`);
check(instant === 0 && await waitUntil(async () => !(await rows()).includes("wa") && (await rows()).includes(fork) && !(await rows()).includes(`└${fork}`)), `the row and the dialog go at once, before the host answers (${instant} left), and its fork becomes a top-level row`);
await q(`document.querySelector('.item[data-work="${fork}"]').click(); true`);
check(await waitUntil(async () => (await app.count("[data-field=fork-parent-gone]")) === 1 && (await app.count("[data-act=fork-parent]")) === 0, 15_000), "the fork's notice still names its parent, without a link");
await app.close();
verdict();
