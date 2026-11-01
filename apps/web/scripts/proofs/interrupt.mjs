// The states between runs, in a browser tab. The host runs in a utility process; the proof kills it with SIGKILL
// (by pid) and the main process starts another one on the same port and token. What the page then shows is the proof:
// the window stays, a resume prompt for the open run, a verdict panel for an execution that may or may not have run,
// a refused stop while an approval is waiting, and a task notice as a quiet line.
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("interrupt");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const stop = { type: "stop", reason: "tool_use" };
const end = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const launch = (script, env) => launchApp({ data: scratch("int-data"), workspace: scratch("int-ws"), fauxScript: script, env: { KISO_WEB_SESSION: "int", KISO_WEB_FAUX_SKIP: "int", ...env } });
const killHost = async (app) => (await app.restart()).pid > 0;

// 1. killed mid-model: the page stays, offers to resume, and the resumed run replaces the half-written draft
let app = await launch([{ events: [{ type: "text_delta", text: "part one, " }, { type: "delay", ms: 6000 }, { type: "text_delta", text: "part two" }, { type: "stop", reason: "end_turn" }] }], { KISO_WEB_MODE: "full-access", KISO_WEB_AUTORUN: "go" });
await app.evaluate("window.__marker = 'same page'");
check(await waitUntil(async () => (await app.text("[data-kind=answer]")) === "part one,"), "the run streams into the page");
check((await killHost(app)) && (await app.evaluate("window.__marker")) === "same page", "kill -9 of the host: another host starts on the same port, the page stays");
check(await waitUntil(async () => (await app.count("[data-kind=resume]")) === 1), "the page offers to resume the interrupted run");
check((await app.count("[data-kind=live]")) === 0 && (await app.evaluate("(() => { const d = document.querySelector('.dotpulse'); return d === null || getComputedStyle(d).display === 'none'; })()")), "nothing pretends to be running: no live row, no spinner");
await app.shot("7-resume-prompt");
await app.click("[data-act=resume]");
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null, 20_000), "after Resume the run finishes");
check((await app.text("[data-kind=answer]")) === "part one, part two" && (await app.count("[data-kind=me]")) === 1 && (await app.count("[data-kind=resume]")) === 0, "the voided draft was replaced once; one turn, no resume card left");
await app.close();

// 2. killed while a command ran: kiso cannot say whether it ran; the person decides
app = await launch([{ events: [call("k1", "shell", { command: "sleep 20; echo should-not-be-trusted" }), stop] }, end("I will not assume it ran.")], { KISO_WEB_MODE: "full-access", KISO_WEB_AUTORUN: "go" });
check(await waitUntil(async () => (await app.count(".step.running")) === 1), "the command is running");
await killHost(app);
check(await waitUntil(async () => (await app.count("[data-kind=verdicts]")) === 1) && /sleep 20/.test(await app.text("[data-kind=verdicts]")), "the page asks about the execution it cannot vouch for, naming the command");
await app.shot("8-verdict-panel");
await app.click("[data-act=abandon]");
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null, 20_000) && (await app.text("[data-kind=answer]")) === "I will not assume it ran." && (await app.count("[data-kind=verdicts]")) === 0, "Skip it: the last verdict resumes the run, which answers");
await app.close();

// 3. a stop while an approval waits is refused with a message; denying it lets the run go on. The page's question about the run
// asked before it started is answered late (as a slow host can): the late answer must not hide the live run, and Stop with it.
app = await launch([{ events: [call("w1", "shell", { command: "touch made.txt" }), stop] }, end("Not run.")], { KISO_WEB_MODE: "default" });
await app.evaluate(`window.__hold = 1; const f = window.fetch; window.fetch = async (u, o) => { const late = /\\/state$/.test(String(u)) && window.__hold-- > 0; const r = await f(u, o); if (late) await new Promise((x) => setTimeout(x, 1500)); return r; }; window.__kiso.abort(); true`);
await sleep(300);
await app.evaluate('window.__kiso.send("go")');
check(await waitUntil(async () => (await app.count("[data-kind=ask]")) === 1), "an approval is waiting");
await sleep(2000);
const clicked = (await app.count("[data-act=stop]")) === 1;
check(clicked, "an answer about the run that arrives after a newer one is dropped: the run is still live on the page, with its Stop");
await app.click("[data-act=stop]");
check(await waitUntil(async () => /waiting for your answer/.test((await app.text("[data-kind=message]")) ?? "")) && (await app.count("[data-kind=ask]")) === 1, `Stop is refused with a message, and the approval is still there (Stop found: ${clicked}; message: ${await app.text("[data-kind=message]")}; cards: ${await app.count("[data-kind=ask]")})`);
await app.shot("9-stop-refused");
await app.click("[data-act=deny]");
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null) && (await app.text("[data-kind=answer]")) === "Not run.", "denying it lets the run finish");
await app.close();

// 4. a command that moved to the background and ended between runs: the model's notice is a quiet line in the next run, not a message of the person's.
app = await launch([{ events: [call("b1", "shell", { command: "sleep 1.5; echo done", foregroundMs: 400 }), stop] }, end("Started."), end("Seen.")], { KISO_WEB_MODE: "full-access", KISO_WEB_MIN_FG_MS: "0", KISO_WEB_AUTORUN: "start it" });
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null), "the first run ended");
await sleep(2500);
await app.evaluate('window.__kiso.send("what happened?")');
check(await waitUntil(async () => (await app.count("[data-kind=me]")) === 2 && (await app.text("[data-kind=footer]")) !== null && (await app.count("[data-kind=footer]")) === 2), "the second run ended");
const rows = await app.evaluate("JSON.stringify([...document.querySelectorAll('[data-kind=me]')].map(d => d.textContent))");
check(rows === '["start it","what happened?"]' && /Task t1 exited/.test(await app.evaluate("document.body.textContent")), "the task notice is not a message of the person's; it reads Task t1 exited inside the run");
await app.close();
verdict();
