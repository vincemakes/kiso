// The host goes away while the page stays open. Under 2 s nothing shows; then "Reconnecting…"; after 30 s "Can't reach kiso" with Retry
// now. Typing still works and Send waits with the reason as its title. Host back: the line goes and the stream catches up with nothing
// doubled. A hidden tab does not try; when it shows again it does.
import { checker, clientFor, launch, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("link-ui");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const [data, workspace, fauxScript] = [scratch("lk-data"), scratch("lk-ws"), [say("First."), say("Second."), say("Third.")]];
const app = await launchApp({ data, workspace, env: { KISO_WEB_SESSION: "lk", KISO_WEB_MODE: "full-access" }, fauxScript });
let host = app.host();
const q = (js) => app.evaluate(js);
const line = () => q("document.querySelector('[data-kind=link]')?.textContent ?? null");
const answers = () => q("[...document.querySelectorAll('[data-kind=answer]')].map((a) => a.textContent).join('|')");
const down = async () => (process.kill(host.pid, "SIGKILL"), new Promise((r) => (host.child.exitCode !== null ? r() : host.child.once("exit", r))));
const back = async () => (host = await launch({ data, workspace, fauxScript, env: { KISO_WEB_MODE: "full-access", KISO_WEB_PORT: String(host.port), KISO_WEB_TOKEN: host.token, KISO_WEB_FAUX_SKIP: "lk" } }));
await q(`window.__kiso.send("one")`);
check(await waitUntil(async () => (await answers()) === "First."), "the first answer is on the page");
check((await line()) === null, "connected: no line");
await down();
await sleep(900);
check((await line()) === null, "the host is gone for under 2 s: nothing is shown");
check(await waitUntil(async () => (await line())?.startsWith("Reconnecting"), 3_000), "after 2 s: Reconnecting…");
const send = await q(`JSON.stringify({ off: document.querySelector('[data-act=send]').disabled, title: document.querySelector('[data-act=send]').title, box: !document.querySelector('textarea').disabled })`).then(JSON.parse);
check(send.off && send.title.startsWith("Reconnecting") && send.box, `Send is disabled with the reason as its title, the box still takes typing`);
await q(`Date.now = ((now) => () => now() + 31_000)(Date.now)`); // 31 s pass
check(await waitUntil(async () => (await line())?.startsWith("Can't reach kiso. Trying again in"), 3_000) && (await app.count("[data-act=retry-now]")) === 1, "after 30 s: Can't reach kiso, the time of the next try, Retry now");
await back();
await app.click("[data-act=retry-now]");
check(await waitUntil(async () => (await line()) === null, 5_000), "the host is back: Retry now connects at once and the line goes");
await clientFor(host).session("lk").run("two");
check(await waitUntil(async () => (await answers()) === "First.|Second.", 8_000), "the stream catches up: the second answer, the first not doubled");
// a hidden tab does not try
await q(`Object.defineProperty(document, "hidden", { configurable: true, get: () => true })`);
await down();
await sleep(1500);
await back();
await clientFor(host).session("lk").run("three");
await sleep(3500);
check((await answers()) === "First.|Second.", "hidden: the page makes no attempt while the host is back and an answer waits");
await q(`delete document.hidden; document.dispatchEvent(new Event("visibilitychange"))`);
check(await waitUntil(async () => (await answers()) === "First.|Second.|Third.", 6_000), "visible again: it tries at once and catches up, each answer once");
await app.closeTab();
await app.chrome.close();
host.child.kill("SIGTERM");
verdict();
