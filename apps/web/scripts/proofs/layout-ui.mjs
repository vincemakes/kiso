// The window is one row of columns (the sidebar, the stream, the panel, the rail), at any width: measured at a wide, a middle and a
// narrow width, with the sidebar closed and open. The columns run in order (sidebar, stream, panel, rail) and no two overlap, none is
// laid over another (no positioning, no z-index), the rail is 244 px whenever it is open (also with a panel open) and only its key closes it, the stream gives way first (to 320 px) and then
// the panel takes its place at width 0 for the stream, and full screen does the same.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("layout-ui");
const app = await launchApp({ data: scratch("lay-data"), workspace: scratch("lay-ws"), env: { KISO_WEB_SESSION: "lay" }, fauxScript: [{ events: [{ type: "text_delta", text: "Hello." }, { type: "stop", reason: "end_turn" }] }] });
const q = (js) => app.evaluate(js);
await q(`window.__kiso.send("hi")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0 && (await app.count("[data-kind=rail]")) === 1, 30_000);
await app.click("[data-act=panel-menu]");
await app.click("[data-open=diff]");
await waitUntil(async () => (await app.count("[data-kind=panel]")) === 1);
const COLUMNS = { side: ".side", chat: ".chat", panel: ".panel", rail: ".rail" };
const measure = () => q(`(() => { const out = {}; for (const [k, s] of Object.entries(${JSON.stringify(COLUMNS)})) { const el = document.querySelector(s); if (!el) continue; const r = el.getBoundingClientRect(), c = getComputedStyle(el); out[k] = { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, pos: c.position, z: c.zIndex }; } const m = document.querySelector('.main').getBoundingClientRect(); out.main = { l: m.left, r: m.right, w: m.width }; return JSON.stringify(out); })()`).then(JSON.parse);
const settle = async (width, sideOpen) => {
	await app.cdp("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: 1, mobile: false });
	if ((await q(`document.querySelector('.win').dataset.side`)) !== (sideOpen ? "1" : "0")) await app.click("[data-act=sidebar]");
	await sleep(1000);
	return measure();
};
const overlap = (a, b) => Math.min(a.r, b.r) - Math.max(a.l, b.l) > 1 && Math.min(a.b, b.b) - Math.max(a.t, b.t) > 1;
let configs = 0;
const problems = [];
for (const width of [1500, 1000, 700]) {
	for (const sideOpen of [false, true]) {
		const m = await settle(width, sideOpen);
		configs += 1;
		const here = `${width}px, sidebar ${sideOpen ? "open" : "closed"}`;
		const cols = Object.entries(m).filter(([k, v]) => k !== "main" && v.w > 0.5);
		for (const [i, [ka, a]] of cols.entries()) for (const [kb, b] of cols.slice(i + 1)) if (overlap(a, b)) problems.push(`${here}: ${ka} and ${kb} overlap`);
		const order = [...cols].sort((a, b) => a[1].l - b[1].l).map(([k]) => k).join();
		if (order !== ["side", "chat", "panel", "rail"].filter((k) => cols.some(([c]) => c === k)).join()) problems.push(`${here}: the columns run ${order}`);
		for (const [k, v] of cols) if (v.z !== "auto" || (v.pos !== "static" && v.pos !== "relative")) problems.push(`${here}: ${k} is ${v.pos} with z-index ${v.z}`);
		if (Math.abs(m.rail.w - 244) > 0.5) problems.push(`${here}: the rail is ${m.rail.w} wide`);
		const room = m.main.w;
		if (room >= 640) {
			if (m.chat.w < 319 || m.panel.w < 319 || Math.abs(m.chat.w + m.panel.w - room) > 2) problems.push(`${here}: stream ${m.chat.w} and panel ${m.panel.w} in ${room}`);
		} else if (m.chat.w > 1 || Math.abs(m.panel.w - room) > 2) problems.push(`${here}: short of room (${room}) the panel should take the stream's place, got stream ${m.chat.w} panel ${m.panel.w}`);
	}
}
check(problems.length === 0, `${configs} layouts (3 widths, sidebar closed and open): no overlap, no positioning or z-index on a column, the rail 244 px, the stream down to 320 then the panel in its place${problems.length ? ` — ${problems.join("; ")}` : ""}`);
let m = await settle(1500, false);
check(m.chat.w >= 319 && Math.abs(m.chat.w - m.panel.w) < 2, "wide: the panel is half the Work, the stream the other half");
await app.shot("layout-wide");
await settle(1000, false);
await app.shot("layout-middle");
await settle(700, true);
await app.shot("layout-narrow");
m = await settle(1500, false);
await app.click("[data-act=panel-full]");
await sleep(700);
m = await measure();
check(m.chat.w <= 1 && Math.abs(m.panel.w - m.main.w) < 2 && Math.abs(m.rail.w - 244) < 1, "full screen: the panel takes the stream's and its own place, the rail stays at 244");
await app.click("[data-act=panel-full]");
await app.click("[data-act=rail]");
await sleep(800);
m = await measure();
check(m.rail.w <= 1 && (await app.count("[data-kind=panel]")) === 1 && Math.abs(m.main.r - 1500) < 1, "only the overview key closes the rail; the panel stays and the Work takes the width");
await app.click("[data-act=rail]");
await sleep(800);
m = await measure();
check(Math.abs(m.rail.w - 244) < 1 && (await app.count("[data-kind=panel]")) === 1, "the rail comes back at 244 beside the open panel");
await app.cdp("Emulation.clearDeviceMetricsOverride", {});
await app.close();
verdict();
