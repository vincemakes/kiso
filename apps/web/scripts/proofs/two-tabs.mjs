// The same Work open in two tabs, an approval answered from both at once: it takes effect once. The command ran once, the log holds
// one decision, and both tabs see the card go and the run finish.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, clientFor } from "./lib.mjs";

const { check, verdict } = checker("two-tabs");
const workspace = scratch("tt-ws");
const app = await launchApp({ data: scratch("tt-data"), workspace, env: { KISO_WEB_MODE: "default", KISO_WEB_SESSION: "tt" }, fauxScript: [
	{ events: [{ type: "tool_call_end", callId: "t1", name: "shell", input: { command: "echo ran >> runs.txt" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Done." }, { type: "stop", reason: "end_turn" }] },
] });
const host = app.host();
const other = await app.chrome.open(`${host.origin}/#session=tt`);
await app.evaluate(`window.__kiso.send("run it")`);
const tabs = [app, other];
/** Each tab in front in turn (a tab behind draws nothing), until `pred` holds for it. */
const inEach = async (pred) => {
	const seen = [];
	for (const t of tabs) seen.push((await t.front(), await waitUntil(() => pred(t), 20_000)));
	return seen.every(Boolean);
};
check(await inEach(async (t) => (await t.count("[data-act=allow]")) === 1), "both tabs show the approval card");
// each tab records what its answer got back, then both answer in the same moment
const record = "window.__answers = []; const f = window.fetch; window.fetch = (...a) => f(...a).then((r) => (String(a[0]).includes('/approv') && window.__answers.push(r.status), r)); true";
await Promise.all(tabs.map((t) => t.evaluate(record)));
await Promise.all(tabs.map((t) => t.click("[data-act=allow]")));
check(await inEach(async (t) => (await t.text("[data-kind=footer]")) !== null), "the run finishes, in both tabs");
const answers = (await Promise.all(tabs.map((t) => t.evaluate("JSON.stringify(window.__answers)")))).map((a) => JSON.parse(a));
check(answers.every((a) => a.length === 1), `both tabs sent their answer (statuses ${JSON.stringify(answers)})`);
check(await inEach(async (t) => (await t.count("[data-kind=ask]")) === 0 && (await t.text("[data-kind=answer]")) === "Done."), "no card is left in either tab, and both show the answer");
check(await inEach(async (t) => (await t.count("[data-kind=message]")) === 0 || !/fail|error/i.test(await t.text("[data-kind=message]"))), "the tab whose answer came second shows no error");
const log = (await clientFor(host).session("tt").replay()).events;
check(log.filter((e) => e.type === "permission_decided").length === 1 && log.filter((e) => e.type === "permission_requested").length === 1, "the log holds one request and one decision");
check(readFileSync(join(workspace, "runs.txt"), "utf8") === "ran\n", "the command ran once");
await other.close();
await app.close();
verdict();
