// Pages the model wrote, rendered in the Open panel from their own preview server: a plain page (inline style and script), a page
// with relative css, js and an image, and a Vite-built React page (module scripts and a stylesheet from /assets/, loaded with
// CORS), built here from the checked-in fixture (its script and style). Each page, once drawn, tells the panel's page what it sees. Screenshots go
// outside the repository.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { checker, launchApp, png, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("preview-pages");
const workspace = scratch("pp-ws");
const tell = (page, extra) => `<script>addEventListener("load", () => parent.postMessage({ page: "${page}", color: getComputedStyle(document.querySelector("h1")).color${extra} }, "*"));</script>`;
writeFileSync(join(workspace, "plain.html"), `<!doctype html><title>Plain</title><style>h1 { color: rgb(36, 87, 197); }</style><h1>Plain</h1>${tell("plain", "")}`);
for (const d of ["rel/css", "rel/js", "rel/img"]) mkdirSync(join(workspace, d), { recursive: true });
writeFileSync(join(workspace, "rel/index.html"), `<!doctype html><title>Relative</title><link rel="stylesheet" href="css/site.css"><h1>Relative</h1><img src="img/logo.png"><script src="js/app.js"></script>`);
writeFileSync(join(workspace, "rel/css/site.css"), "h1 { color: rgb(31, 157, 85); }\n");
writeFileSync(join(workspace, "rel/img/logo.png"), png(30, 20, [[183, 121, 31]]));
writeFileSync(join(workspace, "rel/js/app.js"), `addEventListener("load", () => parent.postMessage({ page: "rel", color: getComputedStyle(document.querySelector("h1")).color, img: document.querySelector("img").naturalWidth }, "*"));\n`);
// the fixture's script and style, with the one-line page Vite starts from (no HTML is kept in the tree); React from this package
const src = join(workspace, "app/src");
mkdirSync(src, { recursive: true });
for (const f of ["main.js", "style.css"]) copyFileSync(fileURLToPath(new URL(`./fixtures/vite-react/${f}`, import.meta.url)), join(src, f));
writeFileSync(join(src, "index.html"), `<!doctype html><meta charset="utf-8"><title>A React page</title><div id="root"></div><script type="module" src="./main.js"></script>`);
const pkg = (name) => dirname(createRequire(import.meta.url).resolve(`${name}/package.json`));
await build({ root: src, logLevel: "silent", resolve: { alias: { react: pkg("react"), "react-dom": pkg("react-dom") } }, build: { outDir: join(workspace, "app/dist"), emptyOutDir: true } });
const ANSWER = "Three pages: plain.html, rel/index.html and app/dist/index.html.";
const app = await launchApp({ data: scratch("pp-data"), workspace, env: { KISO_WEB_SESSION: "pages" }, fauxScript: [{ events: [{ type: "text_delta", text: ANSWER }, { type: "stop", reason: "end_turn" }] }] });
const q = (js) => app.evaluate(js);
await q(`window.__msgs = []; addEventListener("message", (e) => window.__msgs.push({ origin: e.origin, ...e.data })); true`);
await q(`window.__kiso.send("make three pages")`);
await waitUntil(async () => (await app.count("[data-chip]")) === 3, 20_000);
const said = async (page) => {
	await waitUntil(async () => (await q(`window.__msgs.some((m) => m.page === "${page}")`)), 15_000);
	return JSON.parse(await q(`JSON.stringify(window.__msgs.find((m) => m.page === "${page}") ?? null)`));
};
const open = async (path) => {
	await app.click(`[data-chip='${path}']`);
	await waitUntil(async () => (await q(`document.querySelector('[data-panel-body=open]')?.dataset.path`)) === path && (await app.count("iframe.pageview")) === 1);
	return q("document.querySelector('iframe.pageview').dataset.frame");
};
const url = await open("plain.html");
const plain = await said("plain");
check(/^http:\/\/localhost:\d+\/plain\.html$/.test(url) && plain?.color === "rgb(36, 87, 197)" && plain.origin === "null", `a plain page renders with its inline style and script, from ${url}, in an opaque origin`);
check((await q("(({ sandbox, referrerPolicy }) => sandbox.value + '|' + referrerPolicy)(document.querySelector('iframe.pageview'))")) === "allow-scripts|no-referrer", "the frame: sandbox allow-scripts only, no referrer");
await open("rel/index.html");
const rel = await said("rel");
check(rel?.color === "rgb(31, 157, 85)" && rel.img === 30, "a page with relative css, js and an image renders all three");
await open("app/dist/index.html");
const react = await said("react");
check(react?.text === "A React page" && react.color === "rgb(183, 121, 31)", "a Vite-built React page runs its module scripts and its stylesheet from /assets/");
await sleep(400);
await app.shot("preview-pages-react");
await app.click("[data-mode=source]");
check(await waitUntil(async () => (await q("document.querySelector('[data-panel-body=open] pre')?.textContent ?? ''")).includes('type="module"')), "Source shows the page's text");
await app.close();
verdict();
