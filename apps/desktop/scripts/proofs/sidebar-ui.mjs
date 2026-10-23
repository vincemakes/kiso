// The sidebar in the Electron window: closed at first, opens by pushing the Work right, lists the Works of two folders, opens one
// (its log replays), starts a new task, and shows a new Work in the list after its first request. Screenshots go outside the repository.
import { launch, scratch, checker, launchElectron, waitUntil, clientFor } from "./lib.mjs";

const { check, verdict } = checker("sidebar-ui");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("sb-data");
const [wsA, wsB] = [scratch("sb-a"), scratch("sb-b")];
for (const [ws, id, text] of [[wsA, "work-a", "alpha task"], [wsB, "work-b", "beta task"]]) {
	const h = await launch({ data, workspace: ws, fauxScript: [say(`${text} done.`)] });
	const s = clientFor(h).session(id);
	await s.run(text);
	await waitUntil(async () => !(await s.state()).running);
	h.child.kill("SIGTERM");
	await new Promise((r) => h.child.once("exit", r));
}
const app = await launchElectron({ data, workspace: wsB, fauxScript: [say("Fresh answer.")] });
const q = (js) => app.evaluate(js);
const left = () => q(`Math.round(document.querySelector('.main').getBoundingClientRect().left)`);
check((await q(`document.querySelector('.win').dataset.side`)) === "0" && (await left()) === 0, "the sidebar is closed at first");
await app.click("[data-act=sidebar]");
check(await waitUntil(async () => (await left()) === 264), "opening it pushes the Work to the right (no overlay)");
check(await waitUntil(async () => (await app.count(".item")) === 2), "the history lists the Works of both folders");
check((await q(`[...document.querySelectorAll('.item')].map((i) => i.querySelector('.tt').textContent + '@' + i.querySelector('small').textContent).join()`)).split(",").every((x, i) => x.startsWith(["beta task", "alpha task"][i])), "each row: title and folder name, newest first");
check((await app.text(".grp")) === "Today", "grouped by day");
await app.shot("sidebar-open");
await q(`document.querySelector('.item[data-work=work-a]').click()`);
check(await waitUntil(async () => (await app.text("[data-kind=answer]"))?.includes("alpha task done.")), "a click opens a Work of the other folder and replays its log");
await app.click("[data-act=new]");
check(await waitUntil(async () => (await app.count("[data-kind=answer]")) === 0), "New task opens an empty Work");
await q(`window.__kiso.send("gamma task")`);
check(await waitUntil(async () => (await q(`[...document.querySelectorAll('.item .tt')].map((n) => n.textContent).join()`)).startsWith("gamma task"), 20_000), "the new Work joins the list after its first request");
await app.shot("sidebar-new-work");
await q(`document.querySelector('.fn-h').click()`);
await app.click("[data-act=settings]");
check(await waitUntil(async () => (await app.count("[data-kind=settings] select[data-field=mode]")) === 1), "Functions holds Settings, which opens in the window");
await q(`(() => { const sel = document.querySelector('[data-field=mode]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'plan'); sel.dispatchEvent(new Event('change', { bubbles: true })); })()`);
check(await waitUntil(async () => (await q(`document.querySelector('[data-field=mode]').value`)) === "plan"), "the tier changes through the host and the page shows what the host answered");
await app.shot("settings");
await app.click("[data-act=sidebar]");
check(await waitUntil(async () => (await left()) === 0), "closing it gives the width back");
await app.close();
verdict();
