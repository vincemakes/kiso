// A live run with pictures, while the person moves around: they fold a group by hand, switch to another Work and back, and
// reload the page, all while the run still works. Each time, every picture is on the step that made it (the two pictures differ
// in width), the hand-folded group stays folded, and the picture that opened by itself stays open; at the end the other group
// folds as usual and the hand-folded one is still the person's choice.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checker, clientFor, launchApp, png, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("switch-reconnect");
const workspace = scratch("sr-ws");
writeFileSync(join(workspace, "a.bin"), png(200, 100, [[36, 87, 197]]));
writeFileSync(join(workspace, "b.bin"), png(160, 100, [[183, 121, 31]]));
const say = (text) => ({ type: "text_delta", text });
const shell = (callId, command, foregroundMs = 3000) => ({ type: "tool_call_end", callId, name: "shell", input: { command, foregroundMs } });
const app = await launchApp({ data: scratch("sr-data"), workspace, env: { KISO_WEB_SESSION: "sr", KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [
	{ events: [say("Other work."), { type: "stop", reason: "end_turn" }] },
	{ events: [say("First picture."), shell("c1", "cp a.bin a.png && echo a.png"), { type: "stop", reason: "tool_use" }] },
	{ events: [say("Second picture, then a slow check."), shell("c2", "cp b.bin b.png && echo b.png"), shell("c3", "sleep 10; echo checked", 20_000), { type: "stop", reason: "tool_use" }] },
	{ events: [say("Both saved."), { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const other = clientFor(app.host()).session("w2");
await other.run("another task");
await waitUntil(async () => !(await other.state()).running);
await q(`window.__kiso.send("save two pictures")`);
await waitUntil(async () => (await q("[...document.querySelectorAll('.inplace img')].some((i) => i.naturalWidth === 160)")), 20_000);
await app.click("[data-kind=group] .ph");
await sleep(300);
const seen = () => q(`JSON.stringify({
	live: window.__kiso.state.turns.at(-1)?.phase,
	groups: [...document.querySelectorAll('[data-kind=group]')].map((g) => g.dataset.folded + '/' + (g.dataset.hand ?? '-')),
	rows: [...document.querySelectorAll('.step[data-tool=shell]')].map((s) => s.querySelector('.s-obj')?.textContent.split(' ')[1] + '=' + [...s.querySelectorAll('[data-thumb] img, .inplace img')].map((i) => i.naturalWidth).join('+') + (s.dataset.shown === 'true' ? ':shown' : '')),
})`).then(JSON.parse);
const right = (s) => s.rows.join() === "a.bin=200:shown,b.bin=160:shown,10;=";
const now = await seen();
check(now.live === "running" && now.groups.join() === "true/closed,false/-" && right(now), `live: the first group folded by hand, the second open, each picture on its own step, each newest opened by itself (${JSON.stringify(now)})`);
// to another Work and back
const item = async (id) => {
	if ((await app.count(`.item[data-work=${id}]`)) === 0) await app.click("[data-act=sidebar]");
	await waitUntil(async () => (await app.count(`.item[data-work=${id}]`)) === 1);
	await app.click(`.item[data-work=${id}]`);
};
await item("w2");
check(await waitUntil(async () => ((await app.text("[data-kind=answer]")) ?? "").includes("Other work.")), "switched to the other Work");
await item("sr");
await waitUntil(async () => (await seen()).rows.join().includes("160"), 15_000);
await sleep(500);
const back = await seen();
check(back.live === "running" && back.groups.join() === "true/closed,false/-" && right(back), `back while it still runs: the same choices, every picture on its own step (${JSON.stringify(back)})`);
// the page reloaded
await q("location.reload()");
await sleep(1500);
await item("sr");
await waitUntil(async () => (await seen()).rows.join().includes("160"), 15_000);
await sleep(500);
const reloaded = await seen();
check(reloaded.live === "running" && reloaded.groups.join() === "true/closed,false/-" && right(reloaded), `after a reload, still running: the same (${JSON.stringify(reloaded)})`);
await app.shot("switch-reconnect-after-reload");
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
await sleep(600);
const ended = await seen();
check(ended.groups.join() === "true/closed,true/-" && right(ended), `at the end the other group folds; the hand-folded one is still the person's (${JSON.stringify(ended)})`);
await app.close();
verdict();
