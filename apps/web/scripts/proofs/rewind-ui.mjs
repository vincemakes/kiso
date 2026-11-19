// ADR-0062 PR 6 (§ 10b): rewind. A line sent and stopped at once (nothing ran) shows ↺ on its bubble; ↺ takes it back: the
// run it started leaves the stream, the text and the picture come back into the box, the log holds one veto (same Work, same
// session id); sending again goes on. While a run is live ↺ is there but disabled. Screenshots go outside the repository.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep, png } from "./lib.mjs";

const { check, verdict } = checker("rewind-ui");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const slow = { events: [{ type: "delay", ms: 4000 }, { type: "text_delta", text: "never" }, { type: "stop", reason: "end_turn" }] };
const data = scratch("rewind-data");
const app = await launchApp({ data, workspace: scratch("rewind-ws"), env: { KISO_WEB_SESSION: "w-rw" }, fauxScript: [say("One."), slow, say("Fixed."), { events: [{ type: "delay", ms: 1500 }, { type: "tool_call_end", callId: "x1", name: "shell", input: { command: "echo gone" } }, { type: "stop", reason: "tool_use" }] }] });
const q = (js) => app.evaluate(js);
const key = (await fetch(`${app.host().origin}/desk/history`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json())).current.key;
const log = () => readFileSync(join(data, "projects", key, "w-rw.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const ended = () => waitUntil(async () => (await q(`window.__kiso.state.turns.at(-1)?.phase`)) === "ended", 20_000);

await q(`window.__kiso.send("first")`);
await ended();
const picture = png(8, 8, [[200, 40, 40]]).toString("base64");
await q(`window.__kiso.send([{ type: "text", text: "Import the 2024 invoices with a typo" }, { type: "image", sourceType: "base64", mediaType: "image/png", data: "${picture}" }])`);
await waitUntil(async () => (await app.count("[data-act=rewind]")) >= 1, 10_000);
check((await q(`document.querySelector("[data-act=rewind]").disabled`)) === true && (await q(`document.querySelector("[data-act=rewind]").title`)).startsWith("Rewind is unavailable while the Work is running"), "while the run is live, ↺ is there but disabled");
await q(`window.__kiso.abort()`);
await ended();
await waitUntil(async () => (await q(`document.querySelector("[data-act=rewind]")?.disabled`)) === false, 10_000);
check((await app.count("[data-act=rewind]")) === 1, "stopped before anything ran: ↺ on the last bubble only");
const at = await q(`(() => { const r = [...document.querySelectorAll(".me")].at(-1).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y }); // the bubble's actions show on hover, as copy's do
await sleep(300);
await app.shot("pr6-rewind-before");
await app.click("[data-act=rewind]");
await waitUntil(async () => (await q(`document.querySelector('[data-kind=composer] textarea').value`)) !== "", 10_000);
check((await q(`document.querySelector('[data-kind=composer] textarea').value`)) === "Import the 2024 invoices with a typo" && (await app.count("[data-attachment=image]")) === 1, "the text and the picture are back in the box");
check((await q(`[...document.querySelectorAll(".me")].some((m) => m.textContent.includes("with a typo"))`)) === false && (await app.count("[data-act=rewind]")) === 0, "the line and its run left the stream");
check(log().filter((e) => e.type === "user_input_replaced" && e.content === null).length === 1, "the log holds one veto: same Work, same session");
await sleep(300);
await app.shot("pr6-rewind-after");
await q(`window.__kiso.send("Import the 2024 invoices")`);
await waitUntil(() => log().some((e) => e.type === "text_delta" && e.text === "Fixed."), 15_000);
await ended();
check(log().some((e) => e.type === "text_delta" && e.text === "Fixed."), "sending again goes on");
check((await app.count("[data-act=rewind]")) === 0, "a run that finished cannot be taken back");
// Enter, then Esc at once (real key events), before the page has seen the run start (the owner's "send, Esc, ↺"): the run stops, ↺ takes it back
await q(`document.querySelector('[data-kind=composer] textarea').focus(); true`).then(() => app.cdp("Input.insertText", { text: "Delete the old invoices" }));
for (const [key, vk] of [["Enter", 13], ["Escape", 27]]) for (const type of ["keyDown", "keyUp"]) await app.cdp("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: vk, ...(key === "Enter" && type === "keyDown" ? { text: "\r" } : {}) }); // real keys, Esc right after Enter
await waitUntil(() => log().filter((e) => e.type === "terminal").length === 4, 15_000);
check(log().filter((e) => e.type === "terminal").at(-1)?.outcome.kind === "aborted" && !log().some((e) => e.type === "tool_call_end" && e.callId === "x1"), "Enter then Esc at 0 ms: the run stops before it does anything");
check(await waitUntil(async () => (await app.count("[data-act=rewind]")) === 1, 10_000), "and ↺ can take that line back");
await app.close();
verdict();
