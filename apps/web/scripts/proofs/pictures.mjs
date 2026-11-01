// Pictures where they were made, in a browser tab. A Work whose log holds a tool result with an image block (as a product's own
// tool writes it): the row and the group line get its thumbnail, the row opens it in place, a click opens it in the panel, and
// the route serves it from the log only to a signed-in page. A command that writes a picture during a live run: its row opens the
// image by itself while the person follows the bottom. After the host is killed and started again, the Work replays from the log
// and both images still load. Screenshots go outside the repository.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checker, clientFor, launch, launchApp, png, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("pictures");
const data = scratch("pic-data");
const workspace = scratch("pic-ws");
const SHOT = png(240, 144, [[36, 87, 197], [250, 250, 247], [183, 121, 31]]);
writeFileSync(join(workspace, "pic.bin"), png(240, 144, [[31, 157, 85], [29, 29, 31]]));
const end = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
// a Work with a tool result, then its log given an image block in that result
const seed = await launch({ data, workspace, fauxScript: [{ events: [{ type: "text_delta", text: "Capturing the page." }, { type: "tool_call_end", callId: "c1", name: "list_dir", input: {} }, { type: "stop", reason: "tool_use" }] }, end("Here it is.")], env: { KISO_WEB_MODE: "full-access" } });
const s = clientFor(seed).session("pic");
await s.run("take a picture of the page");
await waitUntil(async () => !(await s.state()).running);
seed.child.kill("SIGTERM");
await new Promise((r) => seed.child.once("exit", r));
const projects = join(data, "projects");
const log = join(projects, readdirSync(projects).find((d) => readdirSync(join(projects, d)).includes("pic.jsonl")), "pic.jsonl");
writeFileSync(log, readFileSync(log, "utf8").split("\n").map((line) => {
	if (!line.includes('"type":"tool_result"')) return line;
	const r = JSON.parse(line);
	r.event.content = [{ type: "text", text: "captured" }, { type: "image", sourceType: "base64", mediaType: "image/png", data: SHOT.toString("base64") }];
	return JSON.stringify(r);
}).join("\n"));
const app = await launchApp({ data, workspace, env: { KISO_WEB_SESSION: "pic", KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [
	{ events: [{ type: "tool_call_end", callId: "c9", name: "shell", input: { command: "cp pic.bin shot.png && echo saved shot.png" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "delay", ms: 2500 }, { type: "text_delta", text: "Saved." }, { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const loaded = (sel) => q(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((i) => i.complete ? i.naturalWidth : 0).join()`);
check(await waitUntil(async () => (await loaded(".step [data-thumb=image] img")) === "240" && (await loaded(".ph [data-thumb=image] img")) === "240", 20_000), "the image block of a result in the log: a thumbnail on its row and on its group line, loaded from the log");
const focus = await q("document.querySelector('.step [data-thumb=image]').dataset.artifact");
await app.click("[data-kind=group] .ph");
await app.click(".step[data-shown] .s-row");
check(await waitUntil(async () => (await loaded(".inplace img")) === "240") && (await q("document.querySelector('.step[data-shown]').dataset.shown")) === "true" && (await app.count(".ph [data-thumb], .step [data-thumb]")) === 0, "a click on the row opens the image in place, at column width; then it is the one copy in the stream (not on the open group's line, not on the row)");
await app.click(".inplace [role=button]");
check(await waitUntil(async () => (await q("document.querySelector('[data-panel-body=open]')?.dataset.mode")) === "image" && (await loaded("[data-panel-body=open] img")) === "240"), "a click on the picture opens it in the Open panel");
await sleep(700);
await q("document.querySelector('.scroll').scrollTop = 120");
check((await q("document.querySelector('.scroll').scrollTop > 0 && document.querySelector('.scroll').getBoundingClientRect().top >= document.querySelector('.sidetoggle').getBoundingClientRect().bottom")), "scrolled, the stream starts below the sidebar toggle: no text draws under it");
await app.shot("pictures-1-in-place-and-panel");
const route = `${app.host().origin}/desk/image/${focus.slice(4)}`;
const signedOut = await fetch(route);
const bearer = await fetch(route, { headers: { authorization: `Bearer ${app.host().token}` } });
check(signedOut.status === 401 && bearer.status === 200 && bearer.headers.get("content-type") === "image/png" && Buffer.from(await bearer.arrayBuffer()).equals(SHOT), `the route serves the block's bytes from the log, and refuses a request that is not signed in (${signedOut.status})`);
check((await fetch(`${app.host().origin}/desk/image/pic/0/0`, { headers: { authorization: `Bearer ${app.host().token}` } })).status === 404 && (await fetch(`${app.host().origin}/desk/image/nope/1/1`, { headers: { authorization: `Bearer ${app.host().token}` } })).status === 404, "an event with no image, or a Work that does not exist: 404");
// live: a command saves a picture; following the bottom, its row opens it by itself
await app.click("[data-act=panel-close]");
await q(`window.__kiso.send("save it as a file")`);
check(await waitUntil(async () => (await q("document.querySelector('.step[data-tool=shell]')?.dataset.shown")) === "true" && (await loaded(".step[data-tool=shell] .inplace img")) === "240" && (await q("window.__kiso.state.turns.at(-1).phase")) === "running", 20_000), "live, the newest picture of a group opens in place by itself while the person follows the bottom");
await app.shot("pictures-2-live-auto-open");
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 20_000);
// the host killed and started again; the page reloaded and the Work opened from the sidebar
await app.restart();
await q("location.reload()");
await sleep(1500);
await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count(".item[data-work=pic]")) === 1);
await app.click(".item[data-work=pic]");
check(await waitUntil(async () => (await loaded("[data-thumb=image] img, .inplace img")).split(",").filter((w) => w === "240").length >= 3, 20_000), "after a host restart the Work replays from the log and both pictures load again");
await app.close();
verdict();
