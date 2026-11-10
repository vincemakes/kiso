// The conversation's header in a browser tab (design rev 6.3, owner 2026-11-02). One 54 px row across the main area: the stream's
// header, the rail's and an open panel's top bars end on one line; the overview key and ⋯ keep their place with the rail open, closed
// or given way to a panel; the stream keeps its reading width with both sides closed. The title renames in place (its text selected,
// no box): Enter keeps the name in the runtime's own name store (the sidebar shows it, through a reload and a host restart, and the
// log's bytes do not move), Esc leaves it, an empty name goes back to the first request. The footer's tok/s is the run's output over
// its calls' own time, recomputed here from the log. Screenshots go outside the repository.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeUsage, SessionStore } from "@vincemakes/kiso-runtime";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("header-ui");
const slow = (text, n, ms) => Array.from({ length: n }, (_, i) => [{ type: "text_delta", text: `${text}${i} ` }, { type: "delay", ms }]).flat();
const use = { type: "usage", inputTokens: 1200, outputTokens: 240, cacheRead: 0, cacheWrite: null, known: true };
const data = scratch("hdr-data");
const app = await launchApp({ data, workspace: scratch("hdr-ws"), env: { KISO_WEB_SESSION: "hdr" }, fauxScript: [{ events: [...slow("word", 30, 40), use, { type: "stop", reason: "end_turn" }] }] });
const q = (js) => app.evaluate(js);
const text = (sel) => app.text(sel).then((v) => v ?? "");
await q(`window.__kiso.send("Shorten the install steps")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1 && (await app.count("[data-kind=header]")) === 1, 30_000);
const box = (sel) => q(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r ? { l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width) } : null; })()`);

// one header line, and the two keys in one place whatever the right column holds
// each key's distance from the header's right edge, the overview key before ⋯
const keys = async () => { const h = await box("[data-kind=header]"), r = await box("[data-act=rail]"), m = await box("[data-act=panel-menu]"); return { h, at: [h.r - r.r, h.r - m.r], order: r.r <= m.l + 1 }; };
const railOpen = { hdr: await box("[data-kind=header]"), rail: await box(".rail-h"), keys: await keys() };
await app.click("[data-act=rail]");
await sleep(700);
const railClosed = await keys();
await app.click("[data-act=rail]");
await sleep(700);
await app.click("[data-act=panel-menu]");
await app.click("[data-open=diff]");
await waitUntil(async () => (await app.count("[data-kind=panel]")) === 1);
await sleep(500);
const panel = { pv: await box(".pv-h"), keys: await keys(), hdr: await box("[data-kind=header]") };
check(railOpen.hdr.b === 54 && railOpen.rail.b === 54 && panel.pv.b === 54, `one header line: the stream's header, the rail's and the panel's top bars all end at 54 px (${railOpen.hdr.b}, ${railOpen.rail.b}, ${panel.pv.b})`);
const same = [railOpen.keys, railClosed, panel.keys].every((k) => k.order && k.at.every((d, i) => Math.abs(d - railOpen.keys.at[i]) <= 1 && d < 60));
check(same && railClosed.h.r > railOpen.keys.h.r, `the overview key and ⋯ sit at the conversation's top right, in that order, at the same place with the rail open, closed, or given way to a panel (${JSON.stringify([railOpen.keys.at, railClosed.at, panel.keys.at])})`);
await app.click("[data-act=panel-close]");
await sleep(500);
const before = await box(".col");
await app.click("[data-act=rail]");
await app.click("[data-act=sidebar]");
await sleep(900);
const after = await box(".col");
check(before !== null && after !== null && before.w === after.w, `with the sidebar and the rail both closed, the stream keeps its reading width (${before?.w} → ${after?.w} px)`);
await app.click("[data-act=sidebar]");
await app.click("[data-act=rail]");
await sleep(700);
await app.shot("header-1");

// the title renames in place
const first = await text("[data-field=title]");
check((await app.count("[data-field=title-sub]")) === 0, "the header has the title alone: the folder and branch are in the overview");
const logFile = () => join(data, "projects", readdirSync(join(data, "projects"))[0], "hdr.jsonl");
const logSha = () => createHash("sha256").update(readFileSync(logFile())).digest("hex");
const sha = logSha();
await app.click("[data-field=title]");
const look = () => q("(() => { const el = document.querySelector('[data-field=title-input]'); if (!el) return null; const c = getComputedStyle(el); return { all: el.selectionStart === 0 && el.selectionEnd === el.value.length && el.value.length > 0, border: c.borderTopWidth, bg: c.backgroundColor, focus: document.activeElement === el }; })()");
await waitUntil(async () => (await look())?.all === true);
const editing = await look();
check(first === "Shorten the install steps" && editing.all && editing.focus && editing.border === "0px" && editing.bg === "rgba(0, 0, 0, 0)", "a click on the title selects its text for typing over, in place, with no box");
const type = (v) => q(`(() => { const el = document.querySelector('[data-field=title-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
const key = (k) => q(`document.querySelector('[data-field=title-input]').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true })); true`);
await type("Install steps, shorter");
await key("Escape");
check((await text("[data-field=title]")) === first, "Esc leaves the title as it was");
await app.click("[data-field=title]");
await type("Install steps, shorter");
await key("Enter");
const meta = () => JSON.parse(readFileSync(logFile().replace(/\.jsonl$/, ".meta.json"), "utf8"));
check(await waitUntil(async () => (await text("[data-field=title]")) === "Install steps, shorter" && (await q("[...document.querySelectorAll('.item[data-work=hdr]')].some((e) => e.textContent.includes('Install steps, shorter'))"))), "Enter keeps the name: the header and the sidebar show it");
check(meta().name === "Install steps, shorter" && logSha() === sha, "the name is in the runtime's own name store, and the log's bytes did not move");
await app.restart();
await q("location.reload()");
await sleep(1500);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count(".item[data-work=hdr]")) === 1);
await app.click(".item[data-work=hdr]");
check(await waitUntil(async () => (await text("[data-field=title]")) === "Install steps, shorter", 20_000), "the name stands through a reload and a host restart");
await app.click("[data-field=title]");
await type("   ");
await key("Enter");
const cleared = await waitUntil(async () => (await text("[data-field=title]")) === first);
check(cleared && meta().name === undefined, "an empty name clears it: the title is the first request again");

// tok/s: the run's output over its calls' own time, recomputed from the log
const records = new SessionStore(join(data, "projects", readdirSync(join(data, "projects"))[0])).load("hdr");
const OUT = new Set(["thinking", "text_start", "text_delta", "tool_call_start", "tool_call_end"]);
let [ms, from, to, output] = [0, null, null, 0];
for (const { event: e, ts } of records) {
	if (OUT.has(e.type) && from === null) from = ts;
	if (e.type === "usage" && from !== null) (to = ts), (output = canonicalizeUsage("adapter", e).output);
	if (e.type === "stop" || e.type === "terminal") (ms += from !== null && to !== null ? to - from : 0), (from = to = null);
}
const want = Math.round(output / (ms / 1000));
const shown = Number(/· (\d+) tok\/s$/.exec(await text("[data-kind=footer]"))?.[1] ?? NaN);
check(ms >= 500 && shown === want, `the footer's tok/s (${shown}) is the run's ${output} output tokens over its calls' ${ms} ms, recomputed from the log (${want})`);
await app.close();
verdict();
