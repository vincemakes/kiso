// Fork (plan PR 6, owner 2026-11-02). A Work with two runs is forked at the end of the first from the reply's own action: the new
// Work's log is the parent's lines up to that run's terminal, byte for byte; its sidecar is the parent's profile under "… (fork)"; the
// parent's files do not move, then or when the fork runs. The fork opens at once with one line naming its parent; it starts on the
// parent's tier; its system prompt carries the fork notice (the Context breakdown counts it); the sidebar lists it right after its
// parent, one step in. A cut that is not a run's end, or one with a verdict still owed, is refused in words. Copy puts the reply's
// text, or the person's line, on the clipboard; the relative time follows one rule. Screenshots go outside the repository.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";
import { forkNote } from "../../dist/main/fork.js";
import { ago } from "../../dist/renderer/i18n/index.js";

const { check, verdict } = checker("fork-ui");
const turn = (text) => ({ events: [{ type: "text_delta", text }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] });
const data = scratch("fork-data");
const app = await launchApp({ data, workspace: scratch("fork-ws"), env: { KISO_WEB_SESSION: "frk" }, fauxScript: [turn("First answer."), turn("Second answer."), turn("The fork's answer.")] });
const q = (js) => app.evaluate(js);
const desk = (path, body) => fetch(`${app.host().origin}${path}`, { headers: { authorization: `Bearer ${app.host().token}` }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) }).then(async (r) => ({ status: r.status, ...(await r.json()) }));
const dir = () => join(data, "projects", readdirSync(join(data, "projects"))[0]);
const file = (id, ext = "jsonl") => join(dir(), `${id}.${ext}`);
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

await q(`window.__kiso.send("Plan the release notes")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
await q(`window.__kiso.send("Now the changelog")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 30_000);
await desk("/desk/settings", { session: "frk", mode: "plan" });
const parent = { log: sha(file("frk")), meta: sha(file("frk", "meta.json")) };
const lines = readFileSync(file("frk"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).event);
const ends = lines.filter((e) => e.type === "terminal").map((e) => e.seq);

// refusals, in words
const notEnd = await desk("/desk/fork", { session: "frk", atSeq: lines.find((e) => e.type === "user_input").seq });
const raw = readFileSync(file("frk"), "utf8").split("\n").filter(Boolean);
const cut = raw.findIndex((l) => JSON.parse(l).event.seq === ends[0]);
writeFileSync(file("unc"), `${[...raw.slice(0, cut), JSON.stringify({ runId: "r", ts: 0, event: { seq: ends[0] - 0.5, type: "uncertain_pending", executionId: "x1" } }), raw[cut]].join("\n")}\n`);
const owed = await desk("/desk/fork", { session: "unc", atSeq: ends[0] });
rmSync(file("unc")); // a hand-made log, gone before the folder is listed
check(notEnd.status === 409 && /end of a run/.test(notEnd.message) && owed.status === 409 && /waiting for your verdict/.test(owed.message), `a cut that is not a run's end, and one with a verdict still owed, are refused in words ("${notEnd.message}" / "${owed.message}")`);

// copy, and when it finished
await q("navigator.clipboard.writeText = async (t) => void (window.__copied = t); true");
await q("document.querySelectorAll('[data-kind=reply-acts]')[0].querySelector('[data-act=copy]').click(); true");
const reply = await q("window.__copied");
await q("document.querySelectorAll('[data-kind=me-acts]')[0].querySelector('[data-act=copy]').click(); true");
check(reply === "First answer." && (await q("window.__copied")) === "Plan the release notes", "copy puts the reply's text, or the person's line, on the clipboard");
const at = Date.UTC(2026, 10, 2, 12), rule = [5, 42, 180, 18_000, 172_800, 3_456_000].map((s) => ago(at - s * 1000, at));
check(rule.join("|") === "just now|42s ago|3m ago|5h ago|2d ago|Sep 23" && (await app.text("[data-kind=ago]")) === "just now" && /took/.test(await q("document.querySelector('[data-kind=ago]').title")), `the relative time follows one rule (${rule.join(", ")}); the hover has the exact time and how long the run took`);

// fork from the first reply
await q("document.querySelectorAll('[data-kind=reply-acts]')[0].querySelector('[data-act=fork]').click(); true");
check(await waitUntil(async () => (await app.count("[data-kind=fork-note]")) === 1 && (await app.count("[data-kind=footer]")) === 1, 20_000), "the fork opens at once: the first run only, under one line naming where it came from");
const id = readdirSync(dir()).find((f) => f.endsWith(".jsonl") && !["frk.jsonl", "unc.jsonl"].includes(f)).slice(0, -6);
const prefix = readFileSync(file("frk")).subarray(0, raw.slice(0, cut + 1).reduce((n, l) => n + Buffer.byteLength(l) + 1, 0));
const { name, ...profile } = JSON.parse(readFileSync(file(id, "meta.json"), "utf8"));
const { name: _, ...parentProfile } = JSON.parse(readFileSync(file("frk", "meta.json"), "utf8"));
check(readFileSync(file(id)).equals(prefix), `the fork's log is the parent's lines up to the first run's terminal, byte for byte (${prefix.length} bytes)`);
check(name === "Plan the release notes (fork)" && JSON.stringify(profile) === JSON.stringify(parentProfile) && sha(file("frk")) === parent.log && sha(file("frk", "meta.json")) === parent.meta, "its sidecar is the parent's profile under \"… (fork)\"; the parent's log and sidecar did not move");
const note = await app.text("[data-kind=fork-note]");
const env = await desk(`/desk/env?session=${id}`);
const [mine, theirs] = [await desk(`/desk/context?session=${id}`), await desk("/desk/context?session=frk")];
check(/^Forked from Plan the release notes · just now\. Files are shared/.test(note) && env.mode === "plan" && env.fork?.parent === "frk", `the notice names the parent and the shared folder; the fork starts on the parent's tier (${env.mode})`);
check(mine.system - theirs.system === Buffer.byteLength(`\n\n${forkNote("Plan the release notes")}`), `the fork's system prompt carries the fork notice (${mine.system - theirs.system} bytes more, as the Context breakdown counts)`);
const desktop = JSON.parse(readFileSync(join(data, "desktop.json"), "utf8"));
check(desktop.forks?.[id]?.parent === "frk" && desktop.forks[id].atSeq === ends[0], "the lineage is the host's own record in desktop.json");
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
await waitUntil(async () => (await app.count(`.item[data-work="${id}"]`)) === 1);
const order = await q(`(() => { const items = [...document.querySelectorAll('.item')]; const p = items.findIndex((e) => e.dataset.work === 'frk'); return { next: items[p + 1]?.dataset.work, child: items[p + 1]?.classList.contains('child') }; })()`);
check(order.next === id && order.child, "the sidebar lists the fork right after its parent, one step in");
await sleep(800);
const ans = await q("(() => { const r = document.querySelector('.ans').getBoundingClientRect(); return { x: r.left + 20, y: r.top + 8 }; })()");
await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...ans });
await sleep(300);
await app.shot("fork-1");

// the fork runs; the parent stays as it was
await q(`window.__kiso.send("Take it another way")`);
check(await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 30_000), "the fork runs on its own log");
check(readFileSync(file(id)).subarray(0, prefix.length).equals(prefix) && sha(file("frk")) === parent.log, "its run appends after the copied lines; the parent's log did not move");
await app.click("[data-act=fork-parent]");
check(await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2 && (await app.count("[data-kind=fork-note]")) === 0), "the notice's link opens the parent, both its runs");
await sleep(200);
await app.close();
verdict();
