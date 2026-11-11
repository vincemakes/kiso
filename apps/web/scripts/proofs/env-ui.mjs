// A Work's Environment card: the primary folder and its branch, a folder the shell went into (Recent: a literal `cd` in a call that
// did not fail, never one after `;`), a repository a parsed `gh pr create` printed (Repositories), each row's menu, Add folder from the
// composer's + (the system picker, stubbed) and from a Recent row, Remove, a refusal in words, and the one update line the model gets
// before the next message (never in the bubble). The rows record; only Added folders grant.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { checker, launchApp, scratch, sleep, waitUntil, clientFor } from "./lib.mjs";

const { check, verdict } = checker("env-ui");
const ws = realpathSync(scratch("env-ws"));
const docs = realpathSync(mkdtempSync(join(tmpdir(), "kiso-web-env-docs-")));
const bin = scratch("env-bin");
writeFileSync(join(bin, "gh"), "#!/bin/sh\n[ \"$2\" = view ] && echo feat/site-fix || echo https://github.com/acme/site/pull/7\n");
chmodSync(join(bin, "gh"), 0o755);
const picked = join(bin, "picked");
writeFileSync(picked, docs);
writeFileSync(join(bin, "picker"), `#!/bin/sh\ncat ${picked}\n`);
chmodSync(join(bin, "picker"), 0o755);
mkdirSync(join(ws, "agent"));
execFileSync("git", ["init", "-q", "-b", "feat/env"], { cwd: ws });
execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/api-server.git"], { cwd: ws });
const sh = (callId, command) => ({ type: "tool_call_end", callId, name: "shell", input: { command } });
const app = await launchApp({ data: scratch("env-data"), workspace: ws, env: { KISO_WEB_SESSION: "e1", KISO_WEB_MODE: "full-access", KISO_WEB_PICKER: join(bin, "picker"), PATH: `${bin}:${process.env.PATH}` }, fauxScript: [
	{ events: [sh("c1", `cd ${docs} && ls`), sh("c4", `cd ${ws}/agent && ls`), sh("c2", "cd /nonexistent; echo hello"), sh("c3", "gh pr create --fill"), { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Done." }, { type: "stop", reason: "end_turn" }] },
	{ events: [{ type: "text_delta", text: "Noted." }, { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const rows = (g) => q(`[...document.querySelectorAll('[data-group=${g}] .r-row')].map((r) => r.textContent).join('|')`);
const menu = async (row) => (await app.click(`[data-env-row="${row}"]`), q("[...document.querySelectorAll('[data-kind=env-menu] button')].map((b) => b.textContent).join('|')"));
await q(`window.__kiso.send("go")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0 && (await app.count("[data-group=repos]")) === 1, 30_000);
const here = (await rows("primary")).split("|");
check(here[0].startsWith(basename(ws)) && here[1] === "feat/env", `the primary folder and its branch (${here})`);
check((await rows("recent")).startsWith("agent") && (await app.count("[data-group=recent] .r-row")) === 2, "Recent, newest first: the folders a `cd … &&` went into; `cd /nonexistent; echo hello` makes no row");
check((await rows("repos")) === "acme/site · #7", "Repositories: the pull request a parsed `gh pr create` printed");
const first = await menu("f0");
check(/Copy path/.test(first) && /Open repository on GitHub/.test(first) && /Add folder…/.test(first) && !/Remove|Add to this Work/.test(first), `the primary's menu (${first})`);
check(/Add to this Work/.test(await menu("f2")) && !/Add to this Work/.test(await menu("f1")) && /Open repository on GitHub/.test(await menu("r" + "https://github.com/acme/site/pull/7")) && (await menu("b0")) === "Copy branch name", "a Recent row offers Add to this Work; a Repository row GitHub and Copy name; a branch Copy branch name");
await q(`fetch("/desk/work-pr", { method: "POST", body: JSON.stringify({ session: "e1", pr: "https://github.com/other/lib/pull/3" }) })`);
await app.click(`[data-env-row=f2]`);
await app.click(`[data-menu-act="Add to this Work"]`);
check(await waitUntil(async () => (await app.count("[data-group=added] .r-row")) === 1 && (await app.count("[data-group=recent] .r-row")) === 1), "Add to this Work: the row moves to Added folders; a folder inside the primary is listed but never offers it (nested)");
check((await rows("repos")) === "other/lib · #3|acme/site · #7", "Repositories merge both sources: the hand-linked pull request and the one the log printed");
check(/Remove from this Work/.test(await menu("f1")), "an Added row offers Remove from this Work");
check(/Copy branch name/.test(await menu("rhttps://github.com/acme/site/pull/7")), "once gh has said the pull request's branch, its Repository row offers Copy branch name");
await q(`window.__kiso.send("hi")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 30_000);
const log = (await clientFor(app.host()).session("e1").replay()).events.filter((e) => e.type === "user_input").at(-1);
check(Array.isArray(log.content) && log.content[0].text === `Environment update from kiso (a fact about this session, not a request from the person): added ${docs}. Use absolute paths there.` && log.content[1].text === "hi", "the model's next message carries one update line before it");
check((await q("[...document.querySelectorAll('[data-kind=me]')].at(-1).textContent")) === "hi", "the bubble shows only what the person typed");
await app.click("[data-act=add]");
await app.click("[data-add=folder]");
check(await waitUntil(async () => /already|added|duplicate|nested/i.test((await app.text("[data-kind=attach-note]")) ?? ""), 5_000), "adding the same folder again is refused in the host's words, in the composer");
await app.click(`[data-env-row=f1]`);
await app.click(`[data-menu-act="Remove from this Work"]`);
check(await waitUntil(async () => (await app.count("[data-group=added] .r-row")) === 0 && (await app.count("[data-group=recent] .r-row")) === 2), "Remove: the folder goes back to Recent (the log still has the cd)");
await app.closeTab();
await app.chrome.close();
verdict();
process.exit(process.exitCode ?? 0);
