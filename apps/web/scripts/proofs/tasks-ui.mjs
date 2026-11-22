// Finding #10 and #11 (the web half): many tasks never crowd the tab strip, a lost task is not running, a refused stop says why.
// Four finished tasks, two running, one whose runner is killed (lost track); the Terminal panel, the rail and the hover card.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clientFor, scratch, launchApp, waitUntil, sleep, checker } from "./lib.mjs";

const { check, verdict } = checker("tasks-ui");
const bg = (callId, command, description) => ({ type: "tool_call_end", callId, name: "shell", input: { command, description, background: true } });
const LONG = `cat <<'X' > /dev/null\n${Array.from({ length: 40 }, (_, i) => `line ${i} of a long heredoc that would run off the window`).join("\n")}\nX\nsleep 300`;
const calls = [...[1, 2, 3, 4].map((n) => bg(`c${n}`, `echo ${n}`, `Check node ${n}`)), bg("c5", "sleep 300", "Check the sweater"), bg("c6", "sleep 300", "Watch the build"), bg("c7", LONG, "Write the plan and wait")];
const data = scratch("tui-data");
const app = await launchApp({ data, workspace: scratch("tui-ws"), env: { KISO_WEB_SESSION: "w-t", KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [{ events: [...calls, { type: "stop", reason: "tool_use" }] }, { events: [{ type: "text_delta", text: "Started." }, { type: "stop", reason: "end_turn" }] }] });
const q = (js) => app.evaluate(js);
const host = app.host();
const key = (await fetch(`${host.origin}/desk/history`, { headers: { authorization: `Bearer ${host.token}` } }).then((r) => r.json())).current.key;
const s = clientFor(host).session("w-t");
await s.run("start the checks");
await waitUntil(async () => !(await s.state()).running && (await app.count("[data-field=task]")) === 7, 30_000);
const dir = join(data, "projects", key, "w-t.tasks", "t5");
const pid = readFileSync(join(dir, readdirSync(dir).find((f) => f.includes("journal"))), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.type === "runner_started").pid;
process.kill(pid, "SIGKILL"); // the runner is gone without recording an end: the task is lost track
check(await waitUntil(() => q(`[...document.querySelectorAll("[data-field=task]")].some((r) => r.dataset.status === "lost track")`), 30_000, 300), "a task whose runner vanished reads lost track");
const rows = () => q(`JSON.stringify([...document.querySelectorAll("[data-field=task]")].map((r) => [r.querySelector(".r-nm").textContent, r.dataset.status, !!r.querySelector("[data-act=task-stop]"), r.querySelector(".r-mt").textContent]))`).then(JSON.parse);
const lost = (await rows()).find((r) => r[1] === "lost track");
check(lost !== undefined && lost[2] === false && lost[3] === "lost track", "a lost task has no stop button and no clock");
check((await q(`document.querySelector("[data-section=tasks] .r-cnt")?.textContent`)) === "2", "the section counts the two running tasks, not the lost one");
// a refused stop says why
await q(`window.fetch = ((f) => (u, o) => String(u).includes("/desk/task-stop") ? Promise.resolve(new Response('{"stopped":false}', { status: 200, headers: { "content-type": "application/json" } })) : f(u, o))(window.fetch); document.querySelector("[data-act=task-stop]").click()`);
check(await waitUntil(async () => (await app.count("[data-field=stop-note]")) === 1), "a stop the host answers false says why");
// the hover card stays inside the window
const longRow = JSON.parse(await q(`JSON.stringify((() => { const b = [...document.querySelectorAll("[data-field=task]")].find((r) => r.querySelector(".r-nm").textContent.startsWith("Write")).getBoundingClientRect(); return [b.x + 20, b.y + b.height / 2]; })())`));
await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: longRow[0], y: longRow[1] });
check(await waitUntil(() => q(`(() => { const t = document.querySelector("[data-kind=tip]")?.getBoundingClientRect(); return !!t && t.top >= 0 && t.bottom <= innerHeight && t.height <= 480; })()`)), "a long command's hover card is capped and inside the window");
// the Terminal panel: running tasks, Commands and the focused one are tabs; the other three are in one Finished list
await q(`document.querySelector("[data-field=task]").click()`);
check(await waitUntil(async () => (await app.count(".ptab")) > 0), "the Terminal panel opens");
const tabs = JSON.parse(await q(`JSON.stringify([...document.querySelectorAll(".ptabs .ptab")].map((t) => [t.textContent, t.getBoundingClientRect().width]))`));
check(tabs.length === 3 && tabs.some((t) => t[0] === "Commands") && tabs.every((t) => t[1] >= 90), "tabs: the focused running task, the other running one and Commands, none squeezed");
check((await app.text("[data-act=finished-tab]")) === "Finished (5)", "five tasks (four finished, one lost) are one Finished list");
await app.click("[data-act=finished-tab]");
await app.click("[data-finished]");
check(await waitUntil(async () => (await app.count(".ptabs .ptab")) === 4 && (await app.text("[data-act=finished-tab]")) === "Finished (4)"), "a task opened from the list becomes the tab in focus");
await app.close();
verdict();
