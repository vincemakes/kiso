// kiso web's check for a newer release of itself: the host asks a registry stub at start; a newer release is a small chip above the
// box on the new-conversation screen, "Update available", with a close mark; a click opens the command to copy, "then restart kiso
// web" and what's new, and never runs npm; the close mark hides it for that release only; every failure is silence; the environment
// variable and the Settings switch turn it off (no request reaches the registry). Screenshots go outside the repository.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launch, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("update-notice");
const stub = { mode: "newer", latest: "9.9.9", seen: 0, headers: [] };
const server = createServer((req, res) => {
	stub.seen += 1;
	stub.headers.push(Object.keys(req.headers).sort().join(","));
	if (stub.mode === "slow") return void setTimeout(() => res.end(JSON.stringify({ latest: stub.latest })), 4000);
	res.setHeader("content-type", "application/json");
	res.end(stub.mode === "malformed" ? "<html>no" : JSON.stringify({ latest: stub.latest }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/dist-tags`;
const env = { KISO_UPDATE_ENDPOINT: endpoint, KISO_NO_UPDATE_CHECK: "0" };
const get = (h, path = "/desk/update", init = {}) => fetch(`${h.origin}${path}`, { ...init, headers: { authorization: `Bearer ${h.token}` } }).then((r) => r.json());
const post = (h, body) => get(h, "/desk/update", { method: "POST", body: JSON.stringify(body) });
const hi = [{ events: [{ type: "text_delta", text: "Hi." }, { type: "stop", reason: "end_turn" }] }];
const current = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

// the silent cases, API level: a malformed body, a slow answer, a registry that is down: nothing is known, nothing is said
for (const mode of ["malformed", "slow"]) {
	stub.mode = mode;
	stub.seen = 0;
	const t0 = Date.now();
	const h = await launch({ data: scratch(`upd-${mode}`), workspace: scratch("upd-ws"), env });
	const first = await get(h, "/desk/history");
	check(first !== undefined && Date.now() - t0 < 4000, `${mode}: the first page does not wait for the check`);
	await waitUntil(() => stub.seen > 0, 10_000);
	await sleep(mode === "slow" ? 2200 : 400);
	const s = await get(h);
	check(s.latest === null && s.newer === false && s.enabled === true, `${mode}: no release known, none shown, nothing reported`);
	h.child.kill("SIGINT");
}
// the registry is down (nothing listens)
{
	const h = await launch({ data: scratch("upd-down"), workspace: scratch("upd-ws"), env: { ...env, KISO_UPDATE_ENDPOINT: "http://127.0.0.1:9/dist-tags" } });
	await sleep(1200);
	const s = await get(h);
	check(s.latest === null && s.newer === false, "a registry that is down: silence");
	h.child.kill("SIGINT");
}
// the environment variable: no request at all
stub.mode = "newer";
stub.seen = 0;
{
	const h = await launch({ data: scratch("upd-off"), workspace: scratch("upd-ws"), env: { ...env, KISO_NO_UPDATE_CHECK: "1" } });
	await sleep(1500);
	const s = await get(h);
	check(stub.seen === 0 && s.enabled === false && s.locked === true && s.latest === null, "KISO_NO_UPDATE_CHECK=1: no request reaches the registry, the switch is locked");
	const forced = await post(h, { check: true });
	check(stub.seen === 0 && forced.newer === false, "even Check now asks nothing while it is off");
	h.child.kill("SIGINT");
}
// same, and older: not newer
for (const [label, latest] of [["the same version", current], ["an older version", "0.0.1"]]) {
	stub.latest = latest;
	const h = await launch({ data: scratch("upd-same"), workspace: scratch("upd-ws"), env });
	await waitUntil(async () => (await get(h)).latest === latest, 10_000);
	const s = await get(h);
	check(s.latest === latest && s.newer === false, `${label}: known, and not newer, so no chip`);
	h.child.kill("SIGINT");
}

// the page: a newer release, the chip, the popover, the close mark, a newer one again, Settings
stub.latest = "9.9.9";
stub.seen = 0;
const data = scratch("upd-data");
const app = await launchApp({ data, workspace: scratch("upd-ws2"), env: { ...env, KISO_WEB_SESSION: "w-upd" }, fauxScript: hi });
const q = (js) => app.evaluate(js);
await waitUntil(async () => (await app.count("[data-kind=update-pill]")) === 1, 20_000);
check((await app.count("[data-kind=update-pill]")) === 1 && (await app.text(".upmain"))?.trim() === "Update available" && !/9\.9\.9/.test((await app.text(".upchip")) ?? ""), "a newer release: the chip says Update available, and no version number");
check((await q(`(() => { const p = document.querySelector("[data-kind=update-pill]").getBoundingClientRect(), c = document.querySelector("[data-kind=composer]").getBoundingClientRect(); return p.bottom <= c.top && Math.abs((p.left + p.right) / 2 - (c.left + c.right) / 2) < 6; })()`)) === true, "it sits centred just above the box");
check((await q(`getComputedStyle(document.querySelector(".upchip")).backgroundColor`)) === "rgb(255, 255, 255)" && (await q(`getComputedStyle(document.querySelector(".upchip")).boxShadow`)) !== "none" && (await q(`parseFloat(getComputedStyle(document.querySelector(".upchip")).fontSize)`)) <= 13, "quiet: a white rounded chip, a soft shadow, small text");
await app.shot("pr-h-1-pill");
await q(`window.__copied = null; Object.defineProperty(navigator, "clipboard", { value: { writeText: (x) => ((window.__copied = x), Promise.resolve()) }, configurable: true }); true`);
await app.click("[data-act=update-open]");
await waitUntil(async () => (await app.count("[data-kind=update-popover]")) === 1, 5000);
const pop = (await app.text("[data-kind=update-popover]")) ?? "";
check(pop.includes(`Kiso 9.9.9 is available (you have ${current})`) && pop.includes("then restart kiso web") && pop.includes("What's new") && pop.includes("Copy command"), "the popover: the versions, Copy command, then restart kiso web, What's new");
check((await q(`document.querySelector("[data-act=update-news]").href`)) === "https://github.com/vincemakes/kiso/releases", "What's new is the releases page");
await app.click("[data-act=update-copy]");
await waitUntil(async () => (await q("window.__copied")) !== null, 3000);
check((await q("window.__copied")) === "npm install -g @vincemakes/kiso-web@latest", "Copy command copies the install command, and runs nothing");
await sleep(500);
await app.shot("pr-h-2-popover");
await q(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true`);
await waitUntil(async () => (await app.count("[data-kind=update-popover]")) === 0, 3000);
check(true, "Escape closes the popover");
// never in a running conversation
await q(`window.__kiso.send("hello")`);
check(await waitUntil(async () => (await app.count("[data-kind=update-pill]")) === 0, 15_000), "in a conversation the chip is gone: it belongs to the new-conversation screen only");
await app.close();

// a second page on a fresh Work: the close mark
const app2 = await launchApp({ data, workspace: scratch("upd-ws3"), env: { ...env, KISO_WEB_SESSION: "w-upd2" }, fauxScript: hi });
await waitUntil(async () => (await app2.count("[data-kind=update-pill]")) === 1, 20_000);
await app2.click("[data-act=update-hide]");
check(await waitUntil(async () => (await app2.count("[data-kind=update-pill]")) === 0, 5000), "the close mark hides the chip");
await app2.shot("pr-h-3-after-close");
const hh = () => app2.host();
check((await get(hh())).hidden === true && JSON.parse(readFileSync(join(data, "desktop.json"), "utf8")).updateHidden === "9.9.9", "it is remembered for that release, in desktop.json");
await app2.restart();
await sleep(1500);
check((await get(hh())).hidden === true && (await get(hh())).newer === true, "after a restart, still hidden for 9.9.9");
// a newer release shows it again
stub.latest = "9.9.10";
const forced = await post(hh(), { check: true });
check(forced.latest === "9.9.10" && forced.hidden === false && forced.newer === true, "a newer release is known: hidden is for 9.9.9 only");
await app2.evaluate(`location.reload()`);
await waitUntil(async () => (await app2.count("[data-kind=update-pill]")) === 1, 20_000);
check((await app2.count("[data-kind=update-pill]")) === 1, "after a reload the chip is back for the newer release");
await app2.shot("pr-h-4-newer-again");
// Settings: the version row, Check now, the switch
await app2.evaluate(`[...document.querySelectorAll("button")].find((b) => /Settings/.test(b.textContent))?.click()`);
await waitUntil(async () => (await app2.count("[data-field=version]")) === 1, 10_000);
const row = (await app2.text("[data-field=version]")) ?? "";
check(row.includes(`running ${current}`) && row.includes("latest 9.9.10") && row.includes("Check now"), "Settings: the running version, the latest known, Check now");
await app2.shot("pr-h-5-settings");
await app2.click("[data-act=update-switch]");
await waitUntil(async () => (await get(hh())).enabled === false, 5000);
const before = stub.seen;
const off = await post(hh(), { check: true });
check(off.enabled === false && off.newer === false && stub.seen === before, "the Settings switch off: no chip, and no request even for Check now");
check(stub.headers.every((hd) => !/cookie|authorization/.test(hd)), "the check carries no cookie and no authorization");
await app2.close();
server.close();
verdict();
