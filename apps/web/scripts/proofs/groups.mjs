// Groups in the stream, drawn: narration between tool calls splits a run's steps into groups, in order; every group is open
// while the run is live and folds when it ends, except one the person opened or closed by hand; an approval card stays in
// view when its group is folded by hand; a group line counts its steps by verb and shows +N -N only where the count is exact
// (an edit, a write that created its file), "modified" for a write over a file. Screenshots go outside the repository.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("groups");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const say = (text) => ({ type: "text_delta", text });
const stop = { type: "stop", reason: "tool_use" };
const workspace = scratch("groups-ws");
mkdirSync(join(workspace, "src"));
writeFileSync(join(workspace, "notes.md"), "# Notes\n\nold\n");
writeFileSync(join(workspace, "src", "app.ts"), "export const a = 1;\n");
const app = await launchApp({ data: scratch("groups-data"), workspace, env: { KISO_WEB_MODE: "accept-edits", KISO_WEB_MIN_FG_MS: "0", KISO_WEB_SESSION: "groups" }, fauxScript: [
	{ events: [say("First I read the notes."), call("c1", "read_file", { path: "notes.md" }), call("c0", "read_file", { path: "src/app.ts" }), stop] },
	{ events: [say("They are stale, so I rewrite them whole."), call("c2", "write_file", { path: "notes.md", content: "# Notes\n\nnew\n" }), stop] },
	{ events: [say("Now a plan, a fix, and a check."), call("c3", "write_file", { path: "plan.md", content: "# Plan\n\n- one\n- two\n" }), call("c4", "edit_file", { path: "src/app.ts", edits: [{ oldText: "export const a = 1;", newText: "export const a = 2;\nexport const b = 3;" }] }), call("c5", "shell", { command: "sleep 1; echo checked", foregroundMs: 3000 }), stop] },
	{ events: [say("Done. The plan is in plan.md, the fix in `src/app.ts`, and notes.md is rewritten."), { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const groups = () => q("JSON.stringify([...document.querySelectorAll('[data-kind=group]')].map((g) => ({ folded: g.dataset.folded, hand: g.dataset.hand ?? null, label: g.querySelector('.lab').textContent, delta: g.querySelector(':scope > .ph [data-field=delta]')?.textContent ?? null })))").then(JSON.parse);
await q(`window.__samples = []; window.__touched = false; new MutationObserver(() => window.__kiso?.state.turns.at(-1)?.phase === "running" && !window.__touched && window.__samples.push([...document.querySelectorAll('[data-kind=group]')].map((g) => g.dataset.folded).join())).observe(document.getElementById('root'), { subtree: true, childList: true, attributes: true }); true`);
await q(`window.__kiso.send("tidy the notes, write a plan, fix app.ts and check it")`);
check(await waitUntil(async () => (await app.count("[data-act=allow]")) === 1, 30_000), "the command asks: the run waits with its three groups drawn");
const order = await q("[...document.querySelector('[data-kind=process]').children].map((e) => e.dataset.kind).join()");
check(order === "say,group,say,group,say,group", `narration and groups take turns, in order (${order})`);
const samples = JSON.parse(await q("JSON.stringify(window.__samples)"));
check(samples.length > 3 && samples.every((s) => !s.includes("true")), `while the run was live every group was open (${samples.length} samples)`);
// by hand: the first group closed and opened again, the third (the one waiting) folded
await q("window.__touched = true");
await app.click("[data-kind=group] .ph");
await sleep(200);
await app.click("[data-kind=group] .ph");
await q("[...document.querySelectorAll('[data-kind=group] > .ph')][2].click()");
await sleep(500);
const card = await q("(() => { const c = document.querySelector('[data-kind=ask]'), r = c?.getBoundingClientRect(); return !!c && r.height > 20 && !c.closest('[data-folded=true]'); })()");
check(card && (await groups())[2].folded === "true", "an approval never folds: its group folded by hand, the card is still in view");
await app.shot("groups-1-approval-group-folded");
await app.click("[data-act=allow]");
check(await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000), "allowed, the run ends");
await sleep(600);
const end = await groups();
check(end.map((g) => g.folded).join() === "false,true,true" && end[0].hand === "open" && end[2].hand === "closed", `at the end the groups fold, except by the person's hand: the first, opened again, stays open (${end.map((g) => `${g.folded}/${g.hand}`)})`);
check(end.map((g) => g.label).join("|") === "Read 2 files|Wrote a file|Created a file, edited a file, ran a command", `group lines count by verb, in order: ${end.map((g) => g.label).join(" | ")}`);
check(end[0].delta === null && end[1].delta === "modified" && end[2].delta === "+6−1", `+N -N only where exact: none for a read, "modified" for a write over a file, +6 -1 for a new file plus an edit (${end.map((g) => g.delta)})`);
const rows = await q("JSON.stringify([...document.querySelectorAll('.step')].map((s) => s.querySelector('[data-field=delta]')?.textContent ?? null))").then(JSON.parse);
check(rows.join() === ",,modified,+4,+2−1,", `each row its own: the overwrite "modified", the new file +4, the edit +2 -1 (${rows.join()})`);
const chips = await q("[...document.querySelectorAll('[data-kind=answer] [data-chip]')].map((c) => c.dataset.chip).join()");
check(chips === "plan.md,src/app.ts,notes.md", `the answer's files are chips (${chips})`);
await app.click("[data-kind=group] .ph");
await sleep(500);
await app.shot("groups-2-ended-with-chips");
await app.close();
verdict();
