// A steer a run accepted but never admitted (the run ended first) becomes a new run, started by the page, once.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("unadmitted");
const app = await launchApp({ data: scratch("un-data"), workspace: scratch("un-ws"), env: { KISO_WEB_SESSION: "un" }, fauxScript: [
	{ events: [{ type: "delay", ms: 1200 }, { type: "fail", code: "bad_request", status: 400, retryable: false, message: "scripted failure" }] },
	{ events: [{ type: "text_delta", text: "Got the late line." }, { type: "stop", reason: "end_turn" }] },
] });
await app.evaluate(`window.__kiso.send("first request")`);
await sleep(400);
await app.evaluate(`window.__kiso.steer("late line")`);
check(await waitUntil(() => app.evaluate(`document.body.textContent.includes('Got the late line.')`), 20_000), "the late line is answered by a run of its own");
await sleep(1500);
check((await app.evaluate(`JSON.stringify(window.__kiso.state.turns.map((t) => t.user))`)) === '["first request","late line"]' && (await app.evaluate(`document.body.textContent.split('Got the late line.').length - 1`)) === 1, "it is one new run: two requests, the answer once");
await app.close();
verdict();
