// The hover card of a background task (owner 2026-11-25): small and dark, the name in at most three lines and one line of state,
// whole inside the window wherever the row is (top, middle, bottom), never over the row it describes, its clock keeping time.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("tip-ui");
const cmd = `python3 -c "import json\nrows = [json.loads(l) for l in open('exports/all.jsonl')]\nfor r in rows:\n    if r['kd'] > 40 and r['volume'] > 1000:\n        print(r['keyword'], r['kd'], r['volume'])\n" ; sleep 120`;
const named = "Filter the exported keywords by difficulty and volume, then keep the run open while the second batch of twelve seeds is checked against its manifest";
const bg = (id, input) => ({ events: [{ type: "tool_call_end", callId: id, name: "shell", input: { ...input, background: true } }, { type: "stop", reason: "tool_use" }] });
const app = await launchApp({ data: scratch("tip-data"), workspace: scratch("tip-ws"), env: { KISO_WEB_SESSION: "tip", KISO_WEB_MODE: "full-access" }, fauxScript: [bg("c1", { command: cmd, description: named }), bg("c2", { command: cmd.replace("120", "121") }), { events: [{ type: "text_delta", text: "Started." }, { type: "stop", reason: "end_turn" }] }] });
await app.evaluate(`window.__kiso.send("start them")`);
await waitUntil(async () => (await app.count("[data-field=task]")) === 2, 30_000);
const look = (i) => app.evaluate(`(() => { const t = document.querySelector('[data-kind=tip]'), row = document.querySelectorAll('[data-field=task]')[${i}].getBoundingClientRect(); if (!t) return null; const r = t.getBoundingClientRect(), lines = (e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight)); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, vh: innerHeight, title: lines(t.querySelector('[data-field=tip-title]')), meta: lines(t.querySelector('[data-field=tip-meta]')), clock: t.querySelector('[data-field=tip-meta]').textContent, over: r.right > row.left && r.left < row.right && r.bottom > row.top && r.top < row.bottom, events: getComputedStyle(t).pointerEvents }; })()`);
for (const [h, where] of [[1100, "top"], [560, "middle"], [380, "bottom"]]) {
	await app.cdp("Emulation.setDeviceMetricsOverride", { width: 1100, height: h, deviceScaleFactor: 1, mobile: false }); await sleep(300);
	const seen = [];
	for (const i of [0, 1]) {
		const [x, y] = await app.evaluate(`(() => { const r = document.querySelectorAll('[data-field=task]')[${i}].getBoundingClientRect(); return [r.x + 60, r.y + r.height / 2]; })()`);
		await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 }); await sleep(80);
		await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }); await waitUntil(async () => (await app.count("[data-kind=tip]")) === 1, 3000); await sleep(150);
		seen.push(await look(i));
		if (i === 0) await app.shot(`tip-${where}`);
	}
	check(seen.every((s) => s !== null && s.top >= 0 && s.bottom <= s.vh && s.title <= 3 && s.meta === 1 && !s.over && s.events === "none"), `${where} of the window: each card is whole inside it, the name at most 3 lines, one state line, not over its row, not catching the mouse (${JSON.stringify(seen.map((s) => s && [Math.round(s.top), Math.round(s.bottom), s.vh, s.title, s.meta]))})`);
}
const before = (await look(1)).clock; await sleep(1300);
check((await look(1)).clock !== before, `the card's clock keeps time with the row while it stays open (${before})`);
await app.close();
verdict();
