// A folder with hundreds of changed files keeps the rail light (owner 2026-11-03: 9,871 changes all listed at once): Changes lists
// eight, "Show n more" lists up to 200, and the rest are counted, not drawn.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("rail-lists");
const ID = { GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@x" };
const ws = scratch("lists-ws");
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
for (let i = 0; i < 210; i++) writeFileSync(join(ws, `f${String(i).padStart(3, "0")}.txt`), "x\n");
const turn = { events: [{ type: "text_delta", text: "Looked." }, { type: "stop", reason: "end_turn" }] };
const app = await launchApp({ data: scratch("lists-data"), workspace: ws, fauxScript: [turn], env: { KISO_WEB_SESSION: "lists", ...ID } });
await app.evaluate(`window.__kiso.send("look")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1 && (await app.count("[data-field=change]")) > 0, 30_000);
const more = await app.text("[data-act=more-changes]");
check((await app.count("[data-field=change]")) === 8 && more === "Show 202 more", `Changes lists eight of 210 files, then "${more}"`);
await app.click("[data-act=more-changes]");
check(await waitUntil(async () => (await app.count("[data-field=change]")) === 200 && (await app.text("[data-field=changes-unlisted]")) === "10 more not listed"), "Show more lists 200 and counts the 10 it does not draw");
await app.close();
verdict();
