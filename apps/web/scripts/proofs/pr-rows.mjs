// Finding #16: the rail's Changes lists every pull request a Work opened, not only the folder's branch's. A log with three `gh pr create`
// calls in two repositories: three rows (state and checks from gh, per URL), a merged one asked once, the uncommitted files folded under
// one row. Without gh, and in a folder that is not a repository, the rows still stand (no state, no uncommitted row).
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("pr-rows");
const ID = { GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@x" };
const A = "https://github.com/acme/widgets/pull";
const B = "https://github.com/acme/gadgets/pull";
const stop = (reason) => ({ type: "stop", reason });
const say = (text) => ({ events: [{ type: "text_delta", text }, stop("end_turn")] });
const open = (head) => ({ type: "tool_call_end", callId: `c-${head}`, name: "shell", input: { command: `gh pr create --head ${head} --fill` } });
const script = () => [{ events: [open("one"), open("two"), open("three"), stop("tool_use")] }, say("Opened three."), say("Again.")];
const json = (state, title, add, del, checks) => JSON.stringify({ state, title, additions: add, deletions: del, statusCheckRollup: checks });
const launch = (name, ws, ghBody) => {
	const bin = scratch(`${name}-bin`);
	const log = join(bin, "asked.log");
	writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> ${log}\n${ghBody}\n`);
	chmodSync(join(bin, "gh"), 0o755);
	return { log, run: () => launchApp({ data: scratch(`${name}-data`), workspace: ws, fauxScript: script(), env: { PATH: `${bin}:${process.env.PATH}`, KISO_WEB_SESSION: name, KISO_WEB_MODE: "full-access", ...ID } }) };
};
const asked = (log, url) => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.includes(`pr view ${url} --json state`)).length : 0);

// 1: a repository with an uncommitted file, gh answering per URL
const ws = scratch("prr-ws");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
writeFileSync(join(ws, "a.txt"), "one\n");
execFileSync("git", ["add", "."], { cwd: ws, env: { ...process.env, ...ID } });
execFileSync("git", ["commit", "-qm", "base"], { cwd: ws, env: { ...process.env, ...ID } });
writeFileSync(join(ws, "a.txt"), "one\ntwo\n");
for (let i = 0; i < 11; i++) writeFileSync(join(ws, `n${i}.txt`), "x\n");
const ok = launch("prr", ws, `case "$1 $2" in\n"auth status") exit 0 ;;\n"pr create") case "$*" in *one*) echo ${A}/1 ;; *two*) echo ${A}/2 ;; *) echo ${B}/9 ;; esac ;;\n"pr view") case "$3" in\n${A}/1) echo '${json("MERGED", "Base", 10, 2, [])}' ;;\n${A}/2) echo '${json("OPEN", "Stacked", 4, 1, [{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: "" }])}' ;;\n${B}/9) echo '${json("OPEN", "Gadget", 1, 0, [{ status: "COMPLETED", conclusion: "FAILURE" }])}' ;;\n*) exit 1 ;; esac ;;\n*) exit 1 ;;\nesac`);
const app = await ok.run();
await app.evaluate(`window.__kiso.send("open them")`);
check(await waitUntil(async () => (await app.count("[data-field=pr]")) === 3, 30_000), "three pull requests in two repositories: three rows, none lost to the one-per-repository dedup");
check(await waitUntil(async () => (await app.evaluate(`[...document.querySelectorAll("[data-field=pr]")].map((e) => e.dataset.prState).sort().join()`)) === "MERGED,OPEN,OPEN", 20_000), "each row has the state gh gave for its own URL");
const rows = await app.evaluate(`JSON.stringify([...document.querySelectorAll("[data-field=pr]")].map((e) => [e.textContent, e.querySelector("[data-field=pr-checks]")?.textContent ?? ""]))`).then(JSON.parse);
check(rows.some(([t, c]) => /gadgets|Gadget/.test(t) && c === "1/1") && rows.some(([t, c]) => /Stacked/.test(t) && c === "1/2") && rows.some(([t, c]) => /Base/.test(t) && c === "merged"), `rows carry title and checks, a failed one among the finished (${JSON.stringify(rows)})`);
check((await app.count(".r-ci.bad")) === 1, "the failed check marks its row");
check((await app.text("[data-field=uncommitted]"))?.startsWith("Uncommitted12 files") && (await app.count("[data-field=change]")) === 0, "the twelve uncommitted files are folded under one row");
check((await app.evaluate(`(() => { const r = document.querySelector("[data-field=uncommitted]"); return r.getBoundingClientRect().width <= 281 && [...r.children].every((c) => c.scrollWidth <= c.clientWidth + 1); })()`)), "at the rail's width the row reads whole: name, count and Commit, nothing cut");
await app.shot("pr-rows-folded");
await app.click("[data-field=uncommitted]");
check((await app.count("[data-field=change]")) === 8 && (await app.count("[data-act=commit]")) === 1, "the row opens to its files and carries Commit");
await app.shot("pr-rows");
const before = asked(ok.log, `${A}/1`);
await app.evaluate(`window.__kiso.send("again")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 30_000);
await sleep(1500);
const after = asked(ok.log, `${A}/1`);
check(before === 1 && after === 1, `a merged pull request is asked of gh once for its state (before ${before}, after ${after}; the Environment card's own headRefName ask is a different call and not counted)`);
await app.close();

// 2: no gh answers, and the folder is not a repository
const bare = launch("prr2", scratch("prr2-ws"), `case "$1 $2" in\n"pr create") case "$*" in *one*) echo ${A}/1 ;; *two*) echo ${A}/2 ;; *) echo ${B}/9 ;; esac ;;\n*) exit 1 ;;\nesac`);
const app2 = await bare.run();
await app2.evaluate(`window.__kiso.send("open them")`);
check(await waitUntil(async () => (await app2.count("[data-field=pr]")) === 3, 30_000), "without gh the three rows are still there, from the log");
check((await app2.count("[data-field=pr-checks]")) === 0 && (await app2.count("[data-field=uncommitted]")) === 0, "no state or checks, and no uncommitted row outside a repository");
await app2.shot("pr-rows-nogh");
await app2.close();
verdict();
