// Chips and links in the answer, drawn: a path in prose or inline code becomes a chip only when the host says the file
// exists (one POST /desk/exists for the finished block, never about a code block), a missing one stays text; an outside link
// opens a new tab, a localhost link the Browser preview; a chip opens the Open panel (markdown Rendered and Source, an image
// at fit width or 100%). The exists door answers only for files inside the folder. Screenshots go outside the repository.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep, CHIP_LINES } from "./lib.mjs";

const { check, verdict } = checker("chips");
const workspace = scratch("chips-ws");
for (const d of ["notes", "pics", ".git"]) mkdirSync(join(workspace, d));
writeFileSync(join(workspace, "notes", "plan.md"), "# Plan\n\n- one\n- **two**\n");
writeFileSync(join(workspace, ".git", "config"), "[core]\n");
writeFileSync(join(workspace, "pics", "dot.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const ANSWER = "See notes/plan.md and missing/gone.md, the picture `pics/dot.png`, [the repo](https://github.com/vincemakes/kiso) and [the dev server](http://localhost:5173/).\n\n```\nnotes/plan.md missing/gone.md\n```";
const app = await launchApp({ data: scratch("chips-data"), workspace, env: { KISO_WEB_SESSION: "chips" }, fauxScript: [{ events: [{ type: "text_delta", text: ANSWER }, { type: "stop", reason: "end_turn" }] }] });
const q = (js) => app.evaluate(js);
// for each chip and link: how far its text's bottom is from the text just before it
const BASELINE = `[...document.querySelectorAll('[data-chip], [data-link]')].map((el) => { const at = (n, a, b) => { const r = document.createRange(); r.setStart(n, a); r.setEnd(n, b); return r.getClientRects()[0].bottom; }; const own = [...el.childNodes].filter((n) => n.nodeType === 3).at(-1), prev = el.previousSibling; return Math.abs(at(own, 0, 1) - at(prev, prev.length - 1, prev.length)); })`;
await q(`window.__asked = []; const f = window.fetch; window.fetch = (u, o) => (String(u).startsWith("/desk/exists") && window.__asked.push(JSON.parse(o.body).paths), f(u, o)); true`);
await q(`window.__kiso.send("where is everything?")`);
check(await waitUntil(async () => (await app.count("[data-chip]")) === 2, 20_000), "the answer ends with two chips");
await sleep(500);
const seen = await q("JSON.stringify({ asked: window.__asked, chips: [...document.querySelectorAll('[data-chip]')].map((c) => c.dataset.chip), text: document.querySelector('[data-kind=answer] p').textContent, pre: document.querySelectorAll('pre [data-chip]').length })").then(JSON.parse);
check(seen.asked.length === 1 && seen.asked[0].join() === "notes/plan.md,missing/gone.md,pics/dot.png", `one POST /desk/exists for the finished block, about its prose and inline code only (${JSON.stringify(seen.asked)})`);
check(seen.chips.join() === "notes/plan.md,pics/dot.png" && seen.pre === 0 && seen.text.includes("missing/gone.md"), "an existing path in prose and in inline code: a chip each; the missing path: text; the same paths in a code block: no chip");
const off = await q(`JSON.stringify(${BASELINE})`).then(JSON.parse);
check(off.length === 4 && Math.max(...off) <= 1, `chips and links share the line's baseline with the text around them (off by ${off.map((d) => d.toFixed(1))} px)`);
check(!(await q(CHIP_LINES)).includes("split"), `each chip's icon and text share one line (${await q(CHIP_LINES)})`);
await app.shot("chips-line");
const out = await q("JSON.stringify((({ href, target, rel }) => ({ href, target, rel }))(document.querySelector('[data-link=out]')))").then(JSON.parse);
check(out.href === "https://github.com/vincemakes/kiso" && out.target === "_blank" && /noopener/.test(out.rel) && /noreferrer/.test(out.rel), "an outside link opens a new browser tab, without an opener or a referrer");
await app.click("[data-link=local]");
check(await waitUntil(async () => (await q("document.querySelector('[data-kind=panel] iframe')?.dataset.frame")) === "http://localhost:5173/"), "a localhost link opens the Browser preview on its address");
await app.click("[data-chip='notes/plan.md']");
const body = (s) => q(`document.querySelector('[data-panel-body=open] ${s}')?.textContent ?? null`);
check(await waitUntil(async () => (await body("h1")) === "Plan" && (await q("document.querySelector('[data-kind=panel]').dataset.panel")) === "open"), "a chip opens its file in the Open panel: markdown, Rendered");
await sleep(600);
await app.shot("chips-panel-md-rendered");
await app.click("[data-mode=source]");
check(await waitUntil(async () => (await body("pre"))?.startsWith("# Plan\n")), "Source shows the file's text");
await app.click("[data-chip='pics/dot.png']");
check(await waitUntil(async () => (await q("document.querySelector('[data-panel-body=open]')?.dataset.mode")) === "image" && (await app.count("[data-panel-body=open] img")) === 1), "another chip replaces it: an image, fitted to the width");
await app.click("[data-panel-body=open] img");
check(await q("document.querySelector('[data-panel-body=open] img').classList.contains('actual')"), "a click shows the image at 100%");
const door = await q(`fetch("/desk/exists", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: ["../chips-data/web.json", "/etc/hosts", ".git/config", "notes", "notes/plan.md"] }) }).then((r) => r.json()).then((r) => r.found.join())`);
check(door === "notes/plan.md", `the exists door answers only for files inside the folder: not a path out, an absolute path, a dot folder or a folder (${door})`);
await app.close();
verdict();
