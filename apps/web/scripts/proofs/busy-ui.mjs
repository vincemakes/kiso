// The running mark (owner 2026-11-27): a running step and a running background task draw the kiso mark's four grey dots in one long
// loop, the sidebar's running row a grey breathing dot; no blue spinner anywhere. Eight tasks at once stay ONE animation-frame ticker
// (no per-mark timer), and the ticker stops when the last mark goes, so an idle tab pays nothing. Reduced motion: the mark rests.
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("busy-ui");
const shell = (callId, command, extra = {}) => ({ type: "tool_call_end", callId, name: "shell", input: { command, ...extra } });
const stop = { type: "stop", reason: "tool_use" };
const end = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const app = await launchApp({ data: scratch("busy-data"), workspace: scratch("busy-ws"), env: { KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0", KISO_WEB_SESSION: "busy" }, fauxScript: [
	{ events: [...Array.from({ length: 8 }, (_, i) => shell(`b${i}`, `sleep ${12 + i * 0.2}`, { background: true, description: `Export seed ${i + 1}` })), stop] },
	{ events: [shell("f1", "sleep 10; echo ok", { foregroundMs: 15000 }), stop] },
	end("Started the eight exports."),
	{ events: [shell("r1", "sleep 4", { background: true }), stop] },
	end("One more."),
] });
await app.front();
const q = (js) => app.evaluate(js);
const stats = () => q("JSON.stringify(window.__kisoBusy ?? null)").then(JSON.parse);
const dots = (n) => q(`[...document.querySelectorAll('[data-kind=busy]')].slice(0, ${n}).map((s) => [...s.children].map((c) => c.getAttribute('cx') + ',' + c.getAttribute('cy') + ',' + c.getAttribute('fill-opacity')).join(' ')).join('|')`);
await q(`window.__kiso.send("export the seeds")`);
check(await waitUntil(async () => (await app.count("[data-kind=busy]")) >= 9, 30_000), "eight background tasks and the running step each draw the mark");
check((await app.count(".sp")) === 0, "no blue spinner is left anywhere");
check((await app.count(".s-ic [data-kind=busy]")) === 1 && (await q("document.querySelector('.s-ic [data-kind=busy]').getBoundingClientRect().width")) === 14 && (await q("document.querySelector('.s-req [data-kind=busy]').getBoundingClientRect().width")) === 10, "the step's mark is 14 px, a task line's 10 px");
// one ticker: the mark's frames in a second match the page's own animation frames in that second, with nine marks drawn
const s0 = await stats();
const rafs = await q("new Promise((r) => { let n = 0; const t0 = performance.now(); (function f(t) { n++; t - t0 < 1000 ? requestAnimationFrame(f) : r(n); })(t0); })");
const s1 = await stats();
const frames = s1.frames - s0.frames;
check(s1.mounted >= 9 && Math.abs(frames - rafs) <= 3, `nine marks, one ticker: ${frames} ticker frames against ${rafs} page frames in a second`);
const per = (s1.ms - s0.ms) / Math.max(1, frames);
check(per < 1, `drawing all the marks takes ${per.toFixed(3)} ms a frame`);
const a = await dots(8);
await sleep(450);
check((await dots(8)) !== a, "the dots move between two looks");
check((await app.count(".item.on .dot.run")) === 1 && (await q("getComputedStyle(document.querySelector('.item.on .dot.run')).animationName")) === "breathe" && (await q("getComputedStyle(document.querySelector('.item.on .dot.run')).backgroundColor")) === "rgb(154, 154, 160)", "the running sidebar row breathes a grey dot");
check(await q(`(() => { const row = document.querySelector('.item.on').closest('.row'), d = row.querySelector('.dots'); d.style.display = 'grid'; const a = d.getBoundingClientRect(), b = row.querySelector('.dot').getBoundingClientRect(); d.style.display = ''; return Math.abs(a.left + a.right - b.left - b.right) < 1.2; })()`), "the dot is centred under the row's ⋯, so the hover swap does not jump");
await app.shot("busy-real-size");
// one mark enlarged ten times, a frame every 0.6 s, and the sidebar's three dots side by side (two rows cloned for the frame)
const dir = process.env.KISO_WEB_SHOTS ?? join(tmpdir(), "kiso-web-shots");
mkdirSync(dir, { recursive: true });
const clip = async (name, rect, scale) => writeFileSync(join(dir, `${name}.png`), Buffer.from((await app.cdp("Page.captureScreenshot", { format: "png", clip: { ...JSON.parse(await q(`JSON.stringify((${rect}))`)), scale } })).data, "base64"));
for (let i = 1; i <= 8; i++) (await clip(`busy-frame-${i}`, "(() => { const m = document.querySelector('.s-req [data-kind=busy]'); m.scrollIntoView({ block: 'center' }); const r = m.getBoundingClientRect(); return { x: r.x - 2, y: r.y - 2, width: r.width + 4, height: r.height + 4 }; })()", 10), await sleep(600));
await q(`(() => { const row = document.querySelector('.item.on').closest('.row'); for (const [c, n] of [['amber', 'Waiting for you'], ['blue', 'Finished, unread']]) { const r = row.cloneNode(true); r.dataset.clone = ''; r.querySelector('.item').classList.remove('on'); r.querySelector('.dot').className = 'dot ' + c; r.querySelector('.tt').textContent = n; row.after(r); } })()`);
await clip("busy-sidebar-dots", "(() => { const r = document.querySelector('.item.on').closest('.row').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height * 3 }; })()", 3);
await q("document.querySelectorAll('[data-clone]').forEach((e) => e.remove())");
// the ticker stops with the last mark
check(await waitUntil(async () => (await app.count("[data-kind=busy]")) === 0 && (await app.count("[data-kind=footer]")) === 1, 30_000), "every mark goes when its step and task end");
const idle = await stats();
await sleep(600);
const after = await stats();
check(idle.mounted === 0 && !after.pending && after.frames === idle.frames, `with no mark mounted the ticker is stopped: no frame in 600 ms (${idle.frames} → ${after.frames})`);
// reduced motion: the mark rests and no ticker starts
await app.cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
await q(`window.__kiso.send("one more")`);
check(await waitUntil(async () => (await app.count("[data-kind=busy]")) >= 1, 30_000), "reduced motion: the mark is still drawn");
const r0 = await dots(1);
await sleep(500);
check((await dots(1)) === r0 && !(await stats()).pending, "reduced motion: it rests on the lobes and no ticker runs");
await app.close();
verdict();
