// The rail in a browser tab (rev 3 of the design, owner 2026-11-02): every number it shows equals the same number recomputed from the
// durable log by this script (a call is its latest report, a run the sum of its calls). Context folds to one row and opens to the
// detail; a background task has its row, its last output in the hover, and a stop that ends it; Changes names the branch and the
// file the run edited; Outputs lists what it made and opens it the one way; there is no state of the run itself (no steps, no "Done");
// the footer names the folder, branch and tier; and the rail takes width from the Work (also in a narrow window: a column of the
// row, never laid over the Work). Screenshots go outside the repository.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeUsage, SessionStore } from "@vincemakes/kiso-runtime";
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("rail-ui");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const stop = { type: "stop", reason: "tool_use" };
const workspace = scratch("rail-ws");
mkdirSync(join(workspace, ".git"));
writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/feature-rail\n");
writeFileSync(join(workspace, "README.md"), "# kiso\n\n1. one\n2. two\n3. three\n");
const data = scratch("rail-data");
const app = await launchApp({ data, workspace, env: { KISO_WEB_MODE: "accept-edits", KISO_WEB_MIN_FG_MS: "0", KISO_WEB_SESSION: "rail" }, fauxScript: [
	{ events: [{ type: "text_delta", text: "Reading." }, call("c1", "read_file", { path: "README.md" }), use(1000, 80, 0), stop] },
	{ events: [call("c2", "edit_file", { path: "README.md", edits: [{ oldText: "1. one\n2. two\n3. three", newText: "1. first\n2. second" }] }), use(1300, 60, 1000), use(1300, 64, 1000), stop] },
	{ events: [call("c3", "shell", { command: "echo hello-from-task; sleep 60", foregroundMs: 300 }), use(1400, 40, 1300), stop] },
	{ events: [{ type: "text_delta", text: "All done." }, use(1500, 120, 1400), { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const field = (name) => q(`document.querySelector('[data-field=${name}]')?.textContent ?? null`);
await q(`window.__kiso.send("shorten the readme, then run the slow command")`);
check(await waitUntil(async () => (await app.count("[data-act=allow]")) === 1, 30_000) && (await app.count("[data-field=badge]")) === 0, "a command that asks shows its card in the stream; the overview key carries no count (owner, 2026-11-02)");
await app.click("[data-act=allow]");
check(await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1 && (await app.count("[data-field=task]")) === 1, 30_000), "the run ends with its background task in the rail");
check((await app.count("[data-field=step]")) === 0 && !/\b(Done|Working)\b/.test(await app.text("[data-kind=rail]")), "the rail carries no state of the run itself: no steps, no Done (the stream shows the run)");

// the durable log, read and summed here, independently of the page
const dir = join(data, "projects", readdirSync(join(data, "projects"))[0]);
const events = new SessionStore(dir).load("rail").map((r) => r.event);
const calls = [];
for (const e of events) {
	if (e.type === "usage") (calls.at(-1)?.open ? calls.at(-1) : calls[calls.push({ open: true }) - 1]).last = canonicalizeUsage("adapter", e);
	if (e.type === "stop" && calls.length > 0) calls.at(-1).open = false;
}
const sum = (k) => calls.reduce((n, c) => n + c.last[k], 0);
const [fresh, output, cacheRead] = [sum("input"), sum("output"), sum("cacheRead")];
const lastCall = calls.at(-1).last;
check((await app.count("[data-field=context-detail]")) === 0 && /^\d+%$/.test(await field("context-pct")) && /\/ 200k$/.test(await app.text("[data-field=context-pct]").then(() => app.evaluate("document.querySelector('[data-field=context-pct]').parentElement.textContent.trim()"))), "Context is one folded row; with no stated window it is drawn against 200k (owner 2026-11-02: a number, not ?)");
await app.click("[data-act=fold-context]");
const n = (name) => field(name).then((v) => (v ?? "").replace(/,/g, ""));
check((await n("usage-fresh")) === String(fresh) && (await n("usage-output")) === String(output) && (await field("usage-cache")) === `${Math.round((cacheRead / (fresh + cacheRead)) * 100)}%` && (await field("usage-calls")) === String(calls.length) && (await field("context-detail")).includes((lastCall.input + lastCall.cacheRead).toLocaleString()), "unfolded, Context holds the log's fresh, output, cache rate, request count and the last request's size");
const hover = async (name) => {
	await q(`(() => { const el = document.querySelector('[data-field=${name}]'); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); el.dispatchEvent(new MouseEvent('mouseenter')); })()`);
	return waitUntil(async () => (await app.count("[data-kind=tip]")) === 1, 3000).then(() => q(`document.querySelector('[data-kind=tip]')?.innerText ?? ''`));
};
let tip = await hover("task");
check(tip.includes("hello-from-task") && (await app.count("[data-act=task-stop]")) === 1, "the background task's row: its last output in the hover, and a stop button while it runs");
await q(`document.querySelector('[data-field=task]').dispatchEvent(new MouseEvent('mouseleave'))`);
await app.click("[data-act=task-stop]");
check(await waitUntil(async () => (await app.count("[data-act=task-stop]")) === 0 && /1 finished/.test(await app.text("[data-section=tasks]")), 15_000), "stop ends the task: it leaves the running rows and folds into 1 finished");
await app.click("[data-act=finished]");
check((await app.count("[data-field=task]")) === 1, "the finished row opens to the task it folded");
check((await field("branch")) === "feature-rail" && (await app.count("[data-field=change]")) === 1 && /README\.md\s*\+2\s*−3/.test(await field("change")), "Changes names the branch and the file the run edited, with the edit's lines added and removed");
await app.click("[data-act=fold-changes]");
check((await app.count("[data-field=change]")) === 0, "a section folds from its header");
await app.click("[data-act=fold-changes]");
check((await app.count("[data-field=output]")) === 1 && (await q("document.querySelector('[data-field=output]').dataset.artifact")) === "README.md", "Outputs lists what the Work made: the markdown file it edited, once");
tip = await hover("env");
check((await field("env")).includes("feature-rail") && (await field("tier")) === "Edits allowed" && tip.includes(workspace.split("/").pop()), "the footer names the folder, the branch and the permission tier");
await q(`document.querySelector('[data-field=env]').dispatchEvent(new MouseEvent('mouseleave'))`);
const icons = await q("JSON.stringify([...document.querySelectorAll('[data-kind=rail] svg')].map((e) => { const c = getComputedStyle(e); return [Math.round(parseFloat(c.width)), c.strokeWidth]; }))").then(JSON.parse);
check(icons.length >= 6 && icons.every(([w, sw]) => w === 16 && sw === "1.75px"), `every icon in the rail is one size and one stroke (${icons.length} icons, 16 px, 1.75)`);
await app.click("[data-field=output]");
check(await waitUntil(async () => (await q("document.querySelector('[data-kind=panel]')?.dataset.panel")) === "open" && (await app.count("[data-kind=lightbox]")) === 0 && (await q("document.querySelector('.rail').getBoundingClientRect().width")) <= 1), "an output that is not a picture opens in the Open panel, which takes the rail's place");
await app.click("[data-act=panel-close]");
await waitUntil(async () => (await q("document.querySelector('.rail').getBoundingClientRect().width")) === 280);
await app.shot("rail-open");
const width = () => q(`Math.round(document.querySelector('.main').getBoundingClientRect().right)`);
const wide = await q("innerWidth");
check((await width()) === wide - 280, "in a wide window the rail takes its width from the Work");
await app.click("[data-act=rail]");
check(await waitUntil(async () => (await width()) === wide), "closing it gives the width back");
await app.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 700, deviceScaleFactor: 1, mobile: false });
await app.click("[data-act=rail]");
await waitUntil(async () => (await width()) === 820 - 280);
check((await width()) === 820 - 280 && ["static", "relative"].includes(await q(`getComputedStyle(document.querySelector('.rail')).position`)), "in a narrow window the rail is still a column of the row, 280 wide, not laid over the Work");
await app.shot("rail-narrow");
await app.close();
verdict();
