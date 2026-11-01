// The rail in a browser tab: every number it shows equals the same number recomputed from the durable log by this script
// (a call is its latest report, a run the sum of its calls), the steps match the log's tool calls (no Output section), the background
// task's last output line is in its hover, the environment names the folder, branch and tier, and the rail takes width from the
// Work (also in a narrow window: it is a column of the row, never laid over the Work). Screenshots go outside the repository.
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
	{ events: [call("c3", "shell", { command: "sleep 2; echo hello-from-task", foregroundMs: 300 }), use(1400, 40, 1300), stop] },
	{ events: [{ type: "text_delta", text: "All done." }, use(1500, 120, 1400), { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const field = (name) => q(`document.querySelector('[data-field=${name}]')?.textContent ?? null`);
await q(`window.__kiso.send("shorten the readme, then run the slow command")`);
check(await waitUntil(async () => /Waiting for you/.test((await field("status")) ?? "") && (await field("badge")) === "1", 30_000), "a command that asks puts the rail at Waiting for you, with the badge on its key");
await app.click("[data-act=allow]");
check(await waitUntil(async () => /Done/.test((await field("status")) ?? ""), 30_000), "after the answer the run ends and the rail reads Done");
await waitUntil(async () => (await app.count("[data-field=task]")) === 1 && (await q(`document.querySelector('[data-field=task] .bar.live') === null`)), 15_000);

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
const k = (n) => (n < 1000 ? String(n) : `${(Math.round(n / 100) / 10).toFixed(1)}k`);
check((await field("usage")).startsWith(`${k(fresh + output)} ·`), `the usage line (${await field("usage")}) is the log's fresh ${fresh} + output ${output}`);
const hover = async (name) => {
	await q(`document.querySelector('[data-field=${name}]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); true`);
	await q(`(() => { const el = document.querySelector('[data-field=${name}]'); el.dispatchEvent(new MouseEvent('mouseenter')); })()`);
	return waitUntil(async () => (await app.count("[data-kind=tip]")) === 1, 3000).then(() => q(`document.querySelector('[data-kind=tip]')?.innerText ?? ''`));
};
let tip = await hover("status");
check(tip.includes(fresh.toLocaleString()) && tip.includes(output.toLocaleString()) && tip.includes(`${Math.round((cacheRead / (fresh + cacheRead)) * 100)}%`) && tip.includes(String(calls.length)), "the usage hover holds the log's fresh, output, cache rate and request count");
const lastCall = calls.at(-1).last;
tip = await hover("context");
check(tip.includes((lastCall.input + lastCall.cacheRead).toLocaleString()) && (await field("context-pct")) === "?", "the context hover holds the last request's size from the log; with no stated window the ring reads ?");
const tools = events.filter((e) => e.type === "tool_call_end");
check((await app.count("[data-field=step]")) === tools.length, `one timeline row per tool call in the log (${tools.length})`);
check((await app.count("[data-field=output]")) === 0 && !(await app.text("[data-kind=rail]")).includes("OUTPUT"), "no Output section: what a run made is in the stream");
tip = await hover("task");
check(tip.includes("hello-from-task"), "the background task's hover shows the last line of its output");
tip = await hover("env");
check((await field("env")).includes("feature-rail") && (await field("tier")) === "Edits allowed" && tip.includes(workspace.split("/").pop()), "the footer names the folder, the branch and the permission tier");
await q(`document.querySelector('[data-field=env]').dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))`);
await app.shot("rail-open");
const width = () => q(`Math.round(document.querySelector('.main').getBoundingClientRect().right)`);
const wide = await q("innerWidth");
check((await width()) === wide - 244, "in a wide window the rail takes its width from the Work");
await app.click("[data-act=rail]");
check(await waitUntil(async () => (await width()) === wide), "closing it gives the width back");
await app.cdp("Emulation.setDeviceMetricsOverride", { width: 820, height: 700, deviceScaleFactor: 1, mobile: false });
await app.click("[data-act=rail]");
await waitUntil(async () => (await width()) === 820 - 244);
check((await width()) === 820 - 244 && ["static", "relative"].includes(await q(`getComputedStyle(document.querySelector('.rail')).position`)), "in a narrow window the rail is still a column of the row, 244 wide, not laid over the Work");
await app.shot("rail-narrow");
await app.close();
verdict();
