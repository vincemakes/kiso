// A Work's own pull request (sidebar plan PR C, owner 2026-11-04: per Work, the way the reference desktop app keeps it per session). A
// run whose `gh pr create` call printed a PR URL makes it the Work's: the row shows the PR icon in the state gh gives (merged here). The
// ⋯ menu opens it, unlinks it, and links another by its number in the folder's repository; a link that is neither a URL nor a number is
// refused in words; a later run that opened no PR leaves the link alone. Kept in desktop.json `prs`. Screenshots go outside the repository.
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("work-pr");
const U = "https://github.com/acme/widgets/pull";
const bin = scratch("wpr-bin");
writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2 $3" in\n"pr view ${U}/7") echo MERGED ;;\n"pr view 12") echo ${U}/12 ;;\n"pr view ${U}/12") echo OPEN ;;\n*) exit 1 ;;\nesac\n`);
chmodSync(join(bin, "gh"), 0o755);
const stop = (reason) => ({ type: "stop", reason });
const created = { events: [{ type: "tool_call_end", callId: "p1", name: "shell", input: { command: `echo "${U}/7" # gh pr create --fill` } }, stop("tool_use")] };
const say = (text) => ({ events: [{ type: "text_delta", text }, stop("end_turn")] });
const data = scratch("wpr-data");
const app = await launchApp({ data, workspace: scratch("wpr-ws"), fauxScript: [created, say("Opened it."), say("Nothing new.")], env: { PATH: `${bin}:${process.env.PATH}`, KISO_WEB_SESSION: "wpr", KISO_WEB_MODE: "full-access" } });
const q = (js) => app.evaluate(js);
const prs = () => JSON.parse(readFileSync(join(data, "desktop.json"), "utf8")).prs ?? {};
const ico = () => q(`(() => { const e = document.querySelector('.item[data-work="wpr"] .pr-ico'); return e === null ? null : { state: e.dataset.prState, title: e.title }; })()`);
const menu = async (act) => {
	await q(`document.querySelector('[data-act=work-menu][data-for="wpr"]').click(); true`);
	await waitUntil(async () => (await app.count(`[data-menu-act=${act}]`)) === 1);
	await app.click(`[data-menu-act=${act}]`);
};
const typeLink = (v) => q(`(() => { const el = document.querySelector('[data-field=link-pr-input]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

await q(`window.__kiso.send("Open a pull request for this")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 30_000);
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
check(await waitUntil(async () => (await ico())?.state === "merged", 20_000), `the run's own gh pr create made PR #7 the Work's; its row shows the icon in the state gh gives (${JSON.stringify(await ico())})`);
check(prs().wpr?.number === 7 && prs().wpr.url === `${U}/7` && (await ico()).title === "PR #7 · merged", "kept in desktop.json; the icon's title names it");
await sleep(300);
await app.shot("work-pr-1");

await menu("unlink");
check(await waitUntil(async () => (await ico()) === null && prs().wpr === undefined), "Unlink takes it off the row and out of desktop.json");
await menu("link");
await typeLink("nope");
await app.click("[data-act=link-pr-confirm]");
check(await waitUntil(async () => /URL, or its number/.test(await app.text("[data-kind=link-pr-error]").catch(() => ""))), "a link that is neither a URL nor a number is refused in words");
await typeLink("#12");
await app.click("[data-act=link-pr-confirm]");
check(await waitUntil(async () => (await ico())?.state === "open" && prs().wpr?.url === `${U}/12`, 20_000), "linked by its number: the folder's repository names its URL, and the row shows it open");

await q(`window.__kiso.send("Anything else?")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 30_000);
await sleep(2500);
check(prs().wpr?.number === 12, "a later run that opened no PR leaves the link alone");
await app.close();
verdict();
