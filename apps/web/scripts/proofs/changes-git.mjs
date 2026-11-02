// The rail's Changes from git, and the two writes it makes only on the person's confirm. A real repository on a branch two commits
// ahead of main, a bare repository as origin, and a fake `gh` on PATH that records what it is asked. Changes reads git (branch, base,
// commits ahead, every changed file with its lines); Commit… commits only the ticked files; the pull request dialog pushes nothing
// and creates nothing until its confirm, then pushes the branch and opens the PR into main, and the rail shows it with its checks.
// The Context breakdown's parts add up to the measured size. Screenshots go outside the repository.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("changes-git");
// a person's git has an identity; a CI runner's may not, so the host gets the same one this script commits with
const ID = { GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@x" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ID } }).trim();
const origin = scratch("git-origin");
git(origin, "init", "-q", "--bare", "-b", "main");
const ws = scratch("git-ws");
git(ws, "init", "-q", "-b", "main");
writeFileSync(join(ws, "a.txt"), "one\ntwo\nthree\n");
writeFileSync(join(ws, "d.txt"), "keep\n");
git(ws, "add", ".");
git(ws, "commit", "-qm", "base");
git(ws, "remote", "add", "origin", origin);
git(ws, "push", "-q", "origin", "main");
git(ws, "remote", "set-head", "origin", "main");
git(ws, "checkout", "-qb", "feat/rail");
writeFileSync(join(ws, "a.txt"), "one\n2\nthree\nfour\n");
git(ws, "commit", "-qam", "change a");
writeFileSync(join(ws, "b.txt"), "new file\n");
git(ws, "add", "b.txt");
git(ws, "commit", "-qm", "add b");
writeFileSync(join(ws, "c.txt"), "untracked\n");
writeFileSync(join(ws, "d.txt"), "keep\nmore\n");
// a fake gh: signed in, no pull request until `pr create`, which it records
const bin = scratch("git-bin");
const state = scratch("git-gh");
writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n"auth status") exit 0 ;;\n"pr view") [ -f "${state}/pr" ] && cat "${state}/pr" || exit 1 ;;\n"pr create") printf '%s\\n' "$@" > "${state}/create.args"; echo '{"number":42,"title":"Rail changes","url":"https://example.invalid/pull/42","state":"OPEN","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"IN_PROGRESS","conclusion":""}]}' > "${state}/pr"; echo https://example.invalid/pull/42 ;;\n*) exit 1 ;;\nesac\n`);
chmodSync(join(bin, "gh"), 0o755);
const use = { type: "usage", inputTokens: 3000, outputTokens: 50, cacheRead: 0, cacheWrite: null, known: true };
const turn = (text) => ({ events: [{ type: "text_delta", text }, use, { type: "stop", reason: "end_turn" }] });
const app = await launchApp({ data: scratch("git-data"), workspace: ws, fauxScript: [turn("Looked."), turn("Again.")], env: { PATH: `${bin}:${process.env.PATH}`, KISO_WEB_SESSION: "gitw", ...ID } });
const q = (js) => app.evaluate(js);
const text = (sel) => app.text(sel).then((v) => v ?? "");
await q(`window.__kiso.send("look at the branch")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1 && (await app.count("[data-field=change]")) > 0, 30_000);
const row = (p) => q(`[...document.querySelectorAll('[data-field=change]')].find((e) => e.title === ${JSON.stringify(p)})?.textContent ?? ''`);
check((await text("[data-field=branch]")) === "feat/rail" && /→ main ↑2/.test(await text("[data-field=branch-row]")) && (await app.count("[data-field=change]")) === 4 && /\+2\s*−1/.test(await row("a.txt")) && /new/.test(await row("c.txt")), "Changes is git's: the branch, two commits ahead of main, four files (a.txt +2 −1, the untracked c.txt new)");
check((await app.count("[data-act=commit]")) === 1 && (await app.count("[data-act=create-pr]")) === 0, "with uncommitted files the action is Commit…, not a pull request");

// commit only what is ticked
await app.click("[data-act=commit]");
await waitUntil(async () => (await app.count("[data-commit-file]")) === 2);
await app.click("[data-commit-file='c.txt']");
await q(`(() => { const el = document.querySelector('[data-field=commit-message]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'more in d'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await app.click("[data-act=git-confirm]");
check(await waitUntil(async () => (await app.count("[data-kind=git-dialog]")) === 0) && git(ws, "log", "-1", "--format=%s") === "more in d" && git(ws, "show", "--name-only", "--format=", "HEAD") === "d.txt" && git(ws, "status", "--porcelain") === "?? c.txt", "Commit… commits only the ticked file with the person's message; the unticked one stays out");
rmSync(join(ws, "c.txt"));
await q(`window.__kiso.send("again")`);
check(await waitUntil(async () => (await app.count("[data-act=create-pr]")) === 1, 30_000) && /↑3/.test(await text("[data-field=branch-row]")), "a clean branch ahead of main offers Create PR");

// the pull request: nothing before the confirm
const pushed = () => { try { return git(origin, "rev-parse", "--verify", "--quiet", "refs/heads/feat/rail"); } catch { return ""; } };
await app.click("[data-act=create-pr]");
await waitUntil(async () => (await q("document.querySelector('[data-field=pr-title]')?.value ?? ''")) === "rail");
check(/- change a\n- add b\n- more in d/.test(await q("document.querySelector('[data-field=pr-body]').value")), "the dialog drafts the description from the branch's commits");
await app.click("[data-act=git-cancel]");
check(pushed() === "" && !existsSync(join(state, "create.args")), "Cancel: nothing was pushed and no pull request was asked for");
await app.click("[data-act=create-pr]");
await waitUntil(async () => (await q("document.querySelector('[data-field=pr-title]')?.value ?? ''")) === "rail");
await q(`(() => { const el = document.querySelector('[data-field=pr-title]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, 'Rail changes'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await app.click("[data-act=git-confirm]");
const args = () => (existsSync(join(state, "create.args")) ? readFileSync(join(state, "create.args"), "utf8").split("\n") : []);
check(await waitUntil(async () => (await app.count("[data-field=pr]")) === 1, 20_000) && pushed() === git(ws, "rev-parse", "HEAD") && args().includes("Rail changes") && args()[args().indexOf("--base") + 1] === "main", "the confirm pushes the branch and opens the pull request into main with the person's title");
check(/#42 Rail changes/.test(await text("[data-field=pr]")) && (await text("[data-field=pr-checks]")) === "1/2" && (await app.count("[data-act=create-pr]")) === 0, "the rail shows the pull request and its checks (1 of 2 done)");
await app.shot("changes-git-pr");

// the Context breakdown adds up to the measured size
await app.click("[data-act=fold-context]");
const parts = await q("JSON.stringify([...document.querySelectorAll('[data-part]')].map((e) => [e.dataset.part, Number(e.querySelector('b').textContent.replace(/[^0-9.k]/g, '').replace(/([0-9.]+)k/, (_, n) => String(Number(n) * 1000)))]))").then(JSON.parse);
const sum = parts.filter(([k]) => k !== "free").reduce((n, [, v]) => n + v, 0);
check(["conversation", "system", "tools"].every((k) => parts.some(([p]) => p === k)) && Math.abs(sum - 3000) <= 150, `the breakdown lists the conversation, the system prompt and the tools, and they add up to the measured 3,000 (${sum})`);
await app.close();
verdict();
