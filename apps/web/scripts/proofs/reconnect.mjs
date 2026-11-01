// The browser closes its tab in the middle of a run and opens the page again: the run went on in the host, the new tab is signed in by
// the cookie alone (no code), the stream picks up from the durable log, and nothing is lost or doubled. The command ran once.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep, clientFor } from "./lib.mjs";

const { check, verdict } = checker("reconnect");
const workspace = scratch("rc-ws");
const ANSWER = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
const chunks = ANSWER.match(/.{1,6}/g).flatMap((text) => [{ type: "text_delta", text }, { type: "delay", ms: 150 }]);
const app = await launchApp({ data: scratch("rc-data"), workspace, env: { KISO_WEB_MODE: "full-access", KISO_WEB_SESSION: "rc", KISO_WEB_AUTORUN: "go" }, fauxScript: [
	{ events: [{ type: "text_delta", text: "Running it." }, { type: "tool_call_end", callId: "r1", name: "shell", input: { command: "echo ran >> runs.txt" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [...chunks, { type: "stop", reason: "end_turn" }] },
] });
check(await waitUntil(async () => ((await app.text("[data-kind=answer]")) ?? "").includes("word2")), "the answer streams into the first tab");
await app.closeTab();
const closedAt = Date.now();
await sleep(1500);
const host = app.host();
const s = clientFor(host).session("rc");
check((await s.state()).running, "with no tab open, the run goes on in the host");
const tab = await app.chrome.open(`${host.origin}/#session=rc`);
check((await tab.evaluate("window.__kiso !== undefined")) && (await tab.count("[data-kind=signedout]")) === 0, "the new tab is signed in by the cookie alone");
const partial = (await tab.text("[data-kind=answer]")) ?? "";
check((await tab.count("[data-kind=live]")) === 1 && partial.length > 0 && partial.length < ANSWER.length, `it opens in the middle of the run: live, the answer partly there (${partial.length} of ${ANSWER.length} characters, ${Date.now() - closedAt} ms after the close)`);
check(await waitUntil(async () => (await tab.text("[data-kind=footer]")) !== null, 20_000), "the stream resumes to the end of the run");
check((await tab.text("[data-kind=answer]")) === ANSWER, "the answer is whole: nothing lost, nothing doubled");
const body = await tab.evaluate("document.querySelector('.chat').textContent");
check(body.split("Running it.").length === 2 && (await tab.count("[data-kind=me]")) === 1 && (await tab.count(".step[data-tool=shell]")) === 1, "one request, one narration, one step");
const log = (await s.replay()).events;
check(readFileSync(join(workspace, "runs.txt"), "utf8") === "ran\n" && log.filter((e) => e.type === "tool_execution_started").length === 1, "the command ran once: one line in its file, one execution on the log");
check(new Set(log.map((e) => e.seq)).size === log.length && (await tab.evaluate("window.__kiso.state.turns.length")) === 1, "the durable log and the page agree: one turn");
await tab.close();
await app.close();
verdict();
