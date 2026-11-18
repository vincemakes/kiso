// Renaming a Work, in the header and the sidebar row (owner 2026-11-18): a click away saves like Enter, Esc cancels, Enter then a blur is one request,
// the new name shows at once and never goes back to the old one (idle and running), and a refused rename restores the old name and says why.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("rename-ui");
const say = (text, ms = 0) => ({ events: [{ type: "delay", ms }, { type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const app = await launchApp({ data: scratch("rn-data"), workspace: scratch("rn-ws"), env: { KISO_WEB_SESSION: "rn" }, fauxScript: [say("hi"), say("long", 5000)] });
const q = (js) => app.evaluate(js);
await q(`window.__kiso.send("first")`); await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 20_000);
await q("window.__rn = []; const f = fetch; window.fetch = (u, o) => (String(u).includes('/desk/rename') && window.__rn.push(JSON.parse(o.body).name), f(u, o)); true");
const seen = () => q("JSON.stringify([document.querySelector('[data-field=title]')?.textContent, document.querySelector('.item[data-work=rn] .tt')?.textContent])").then(JSON.parse);
const key = (k) => app.cdp("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 27 }).then(() => app.cdp("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, windowsVirtualKeyCode: k === "Enter" ? 13 : 27 }));
const away = async () => { for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await app.cdp("Input.dispatchMouseEvent", { type, x: 700, y: 330, button: "left", clickCount: 1 }); };
const open = async (side) => { if (side) { await q(`document.querySelector('[data-act=work-menu][data-for=rn]').click()`); await waitUntil(async () => (await app.count("[data-kind=work-menu]")) === 1); await q("document.querySelector('[data-menu-act=rename]').click()"); } else await app.click("[data-field=title]"); await waitUntil(async () => (await app.count(side ? "[data-field=row-title-input]" : "[data-field=title-input]")) === 1, 5000); await sleep(200); };
const type = (side, name) => q(`(() => { const i = document.querySelector('[data-field=${side ? "row-title-input" : "title-input"}]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
// every sample for 1.5 s after the commit: never the old name in either place, and in the end the new one in both
const steady = async (name, old) => { const bad = []; for (let i = 0; i < 30; i++) { const [h, s] = await seen(); if (h === old || s === old) bad.push([h, s]); await sleep(50); } const [h, s] = await seen(); return h === name && s === name ? bad : [...bad, [h, s]]; };
for (const [side, label] of [[false, "header"], [true, "sidebar row"]]) {
	const n0 = (await q("window.__rn.length")), old0 = (await seen())[side ? 1 : 0], [a, b, c] = ["by click", "by enter", "esc"].map((w) => `${label} ${w}`);
	await open(side); await type(side, a); await away(); let bad = await steady(a, old0);
	check(bad.length === 0 && (await q("window.__rn.length")) === n0 + 1, `${label}: a click away saves, the new name never flickers back (${JSON.stringify(bad.slice(0, 2))})`);
	await open(side); await type(side, b); await key("Enter"); await away(); bad = await steady(b, a);
	check(bad.length === 0 && (await q("window.__rn.length")) === n0 + 2, `${label}: Enter saves, and Enter then a blur sends one request (${(await q("window.__rn.length")) - n0 - 1})`);
	await open(side); await type(side, c); await key("Escape"); await sleep(300);
	check((await seen()).every((x) => x === b) && (await q("window.__rn.length")) === n0 + 2 && (await app.count("[data-field=title-input], [data-field=row-title-input]")) === 0, `${label}: Esc leaves the name as it was and sends nothing`);
}
// while it runs, the page re-renders all the time: a click away still saves, and nothing goes back to the old name
await q(`window.__kiso.send("again")`); const running = () => q("document.querySelector('.item[data-work=rn]')?.dataset.state === 'running'"); await waitUntil(running, 5000); await sleep(300);
const was = (await seen())[0]; await open(false); await type(false, "while running"); await away(); const bad = await steady("while running", was);
check(bad.length === 0 && (await running()), `a click away saves while the Work runs, and the name holds (${JSON.stringify(bad.slice(0, 2))})`);
// a refused rename puts the old name back and says why
await waitUntil(async () => !(await running()), 20_000); const kept = (await seen())[0]; await q("const g = window.fetch; window.fetch = (u, o) => (String(u).includes('/desk/rename') ? Promise.resolve(new Response('{\"error\":\"no\"}', { status: 409 })) : g(u, o)); true");
await open(false); await type(false, "refused"); await key("Enter"); await sleep(800);
check((await seen())[0] === kept && (await app.count("[data-field=title-error]")) === 1, `a refused rename: the old name is back and the refusal shows (${JSON.stringify(await seen())})`);
await app.close(); verdict();
