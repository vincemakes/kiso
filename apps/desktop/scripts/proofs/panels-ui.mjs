// The panels in the Electron window: the ⋮ menu, Changes (the run's diff), Files (the tree, the changed mark, a markdown preview,
// folded folders), Terminal and tasks (a background task's log), Preview (a dev server's address found in the log, loaded in a
// sandboxed frame, a refused address), the half and full widths, and a thumbnail in the stream that opens its panel.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchElectron, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("panels-ui");
let hits = 0;
const dev = createServer((req, res) => {
	hits += 1;
	res.writeHead(200, { "content-type": "text/html" });
	res.end("<h1>preview-ok</h1>");
});
await new Promise((r) => dev.listen(0, "127.0.0.1", r));
const devUrl = `http://localhost:${dev.address().port}/`;
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const stop = { type: "stop", reason: "tool_use" };
const workspace = scratch("pn-ws");
writeFileSync(join(workspace, "README.md"), "# Title\n\n1. one\n2. two\n3. three\n\nSome *words*.\n");
mkdirSync(join(workspace, "node_modules"));
mkdirSync(join(workspace, "src"));
const app = await launchElectron({ data: scratch("pn-data"), workspace, env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_MIN_FG_MS: "0", KISO_DESKTOP_SESSION: "pn" }, fauxScript: [
	{ events: [call("c0", "read_file", { path: "README.md" }), stop] },
	{ events: [call("c1", "edit_file", { path: "README.md", edits: [{ oldText: "1. one\n2. two\n3. three", newText: "1. first\n2. second" }] }), stop] },
	{ events: [call("c2", "shell", { command: `echo "  Local:   ${devUrl}"; sleep 20`, foregroundMs: 300 }), stop] },
	{ events: [{ type: "text_delta", text: "Done." }, { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
await q(`window.__kiso.send("edit the readme and start the dev server")`);
check(await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0 && (await app.count("[data-field=task]")) === 1, 40_000), "a run edits a file and starts a background command");
const geo = () => q(`(() => { const r = (s) => document.querySelector(s)?.getBoundingClientRect(); const m = r('.main'), c = r('.chat'), p = r('.panel'); return JSON.stringify({ mainRight: Math.round(m.right), chatRight: Math.round(c.right), panelLeft: p ? Math.round(p.left) : null, mainLeft: Math.round(m.left), width: innerWidth }); })()`).then(JSON.parse);
check((await app.count("[data-kind=panel]")) === 0, "no panel is open at first");
await app.click("[data-act=panel-menu]");
check(await waitUntil(async () => (await app.count("[data-kind=panel-menu] [data-open]")) === 4), "the ⋮ menu lists the four panels");
await app.click("[data-open=diff]");
check(await waitUntil(async () => (await app.count("[data-change='README.md']")) === 1), "Changes shows the file the run edited");
check(/\+2 −3/.test(await app.text("[data-change='README.md'] .h")) && (await app.text("[data-change='README.md']")).includes("- 1. one"), "with its added and removed lines");
let g = await geo();
await waitUntil(async () => { g = await geo(); return g.panelLeft !== null && Math.abs(g.chatRight - g.panelLeft) <= 2; }, 5000);
check(g.panelLeft !== null && Math.abs(g.chatRight - g.panelLeft) <= 2 && g.panelLeft > g.mainLeft + (g.mainRight - g.mainLeft) * 0.5, "the panel is half the Work's width, beside it; the Work does not go under it");
await app.shot("panel-changes");
await app.click("[data-act=panel-full]");
await sleep(900);
g = await geo();
check(g.panelLeft === g.mainLeft, "full screen: the panel covers the Work, up to the rail");
await app.click("[data-act=panel-full]");
await app.click("[data-act=panel-menu]");
await app.click("[data-open=files]");
check(await waitUntil(async () => (await app.count("[data-entry]")) >= 3), "Files lists the folder");
check((await q(`document.querySelector('[data-entry="node_modules"]').dataset.folded`)) === "true" && (await app.text('[data-entry="node_modules"]')).includes("not listed"), "dependencies are folded as not listed");
check((await app.text('[data-entry="README.md"]')).includes("changed"), "the file the run changed is marked");
await q(`document.querySelector('[data-entry="README.md"]').click()`);
check(await waitUntil(async () => (await q(`document.querySelector('.mdprev h1')?.textContent`)) === "Title"), "a click previews it: markdown, drawn");
await app.shot("panel-files");
await app.click("[data-act=panel-menu]");
await app.click("[data-open=term]");
check(await waitUntil(async () => (await q(`document.querySelector('[data-log=task]')?.textContent ?? ''`)).includes(devUrl), 15_000), "Terminal and tasks shows the background task's log");
await app.click("[data-act=panel-menu]");
await app.click("[data-open=web]");
check(await waitUntil(async () => (await q(`document.querySelector('[data-frame]')?.dataset.frame ?? ''`)) === devUrl, 10_000), "Preview finds the dev server's address in the log and loads it");
check((await q(`document.querySelector('[data-frame]').getAttribute('sandbox')`)).split(" ").sort().join() === "allow-forms,allow-same-origin,allow-scripts" && await waitUntil(async () => hits > 0, 8000), "in a sandboxed frame, and the server was reached (the page's policy allows the frame)");
const typeUrl = async (text) => {
	await q(`(() => { const el = document.querySelector('[data-field=url]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
	await sleep(300);
};
await typeUrl("https://example.com");
check((await app.count(".pnote.warn")) === 1 && (await q(`document.querySelector('[data-frame]').dataset.frame`)) === devUrl, "an address that is not on this computer is refused and the page stays");
await typeUrl(`localhost:${await q("location.port")}`);
check((await app.count(".pnote.warn")) === 1 && (await q(`document.querySelector('[data-frame]').dataset.frame`)) === devUrl, "this app's own address is refused too");
await app.shot("panel-preview");
await app.click("[data-act=panel-close]");
check(await waitUntil(async () => (await app.count("[data-kind=panel]")) === 0 && (await geo()).chatRight === (await geo()).mainRight), "closing gives the width back");
await q(`document.querySelector('[data-thumb=diff]').click()`);
check(await waitUntil(async () => (await q(`document.querySelector('[data-kind=panel]')?.dataset.panel`)) === "diff"), "a thumbnail in the stream opens its panel");
await app.close();
dev.close();
verdict();
