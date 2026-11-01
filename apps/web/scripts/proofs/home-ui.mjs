// The home screen in a browser tab: the folder chip and the in-page folder browser (home, a typed path, open a folder), the shortcut,
// a permission tier per Work, notifications turned on with a click and a notification's click opening its Work at its approval, and the
// first-run guide (a key typed into the field is gone from the page at once and never in its text). Screenshots go outside the repository.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("home-ui");
const [wsA, wsB] = [scratch("home-a"), scratch("home-b")];
const data = scratch("home-data");
const notices = join(data, "notices.jsonl");
writeFileSync(notices, "");
const home = scratch("home-home");
mkdirSync(join(home, "proj"));
const app = await launchApp({ data, workspace: wsA, env: { KISO_WEB_SESSION: "h1", KISO_WEB_NOTIFY_LOG: notices, HOME: home }, fauxScript: [
	{ events: [{ type: "tool_call_end", callId: "w", name: "write_file", input: { path: "x.txt", content: "hello" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Written." }, { type: "stop", reason: "end_turn" }] },
] });
const q = (js) => app.evaluate(js);
const chip = () => app.text("[data-field=folder]");
const name = (p) => p.split("/").pop();
check(await waitUntil(async () => (await chip()) === name(wsA)) && (await app.count("[data-kind=home]")) === 1, "an empty Work is the home screen: the folder chip names the folder it runs in");
await app.shot("home");
await app.click("[data-act=folder]");
check(await waitUntil(async () => (await app.count("[data-kind=folder-menu]")) === 1), "the chip opens a menu to choose another folder");
await app.click("[data-act=pick]");
check(await waitUntil(async () => (await app.count("dialog[data-kind=folders][open] [data-dir=proj]")) === 1) && (await app.count("[data-dir]")) === 1, "the folder browser opens on the home folder and lists its folders");
await app.shot("folders");
await q(`(() => { const el = document.querySelector('[data-field=root]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(wsB)}); el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act=root]').click(); })()`);
check(await waitUntil(async () => (await app.text("[data-field=full]")) === realpathSync(wsB)), "a typed full path becomes the root it browses");
await app.click("[data-act=choose]");
check(await waitUntil(async () => (await chip()) === name(wsB)) && (await app.count("dialog[open]")) === 0, "opening it starts an empty Work in that folder and closes the browser");
await q(`window.__kisoMark = window.__kiso; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })); true`);
await waitUntil(async () => (await app.count("dialog[open] [data-dir=proj]")) === 1);
await app.click("[data-dir=proj]");
await waitUntil(async () => (await app.text("[data-field=full]")) === join(realpathSync(home), "proj"));
await app.click("[data-act=choose]");
check(await waitUntil(async () => (await chip()) === "proj" && (await q("window.__kiso !== window.__kisoMark"))), "the shortcut opens it too: a folder in home, chosen by a click, opens a new Work");
// notifications: off until a click turns them on (the browser's Notification is replaced by a recorder; a headless browser shows none)
await q(`window.__notes = []; window.Notification = class { static permission = "default"; static async requestPermission() { this.permission = "granted"; return "granted"; } constructor(title, o) { this.title = title; Object.assign(this, o); window.__notes.push(this); } close() {} }; true`);
await q("document.querySelector('[data-act=sidebar]').click(); document.querySelector('.fn-h').click()");
await app.click("[data-act=settings]");
check(await waitUntil(async () => (await q("document.querySelector('[data-field=notify]')?.dataset.state")) === "off"), "notifications are off at first");
await app.click("[data-act=notify]");
check(await waitUntil(async () => (await q("document.querySelector('[data-field=notify]')?.dataset.state")) === "on"), "a click asks the browser and turns them on");
await q("document.querySelector('[data-act=new]').click(); document.querySelector('[data-act=sidebar]').click()");
await waitUntil(async () => (await app.count("[data-kind=home]")) === 1);
const setTag = (v) => q(`(() => { const el = document.querySelector('[data-field=tag]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
const tag = () => q("document.querySelector('[data-field=tag]')?.value");
await setTag("plan");
check(await waitUntil(async () => (await tag()) === "plan"), "the tag changes this Work's tier through the host");
await q("document.querySelector('[data-act=new]').click()");
check(await waitUntil(async () => (await app.count("[data-kind=home]")) === 1 && (await tag()) === "default"), "another Work still has the default tier");
// a Work that asks, then the person goes elsewhere
await q(`window.__kiso.send("write the file")`);
check(await waitUntil(async () => (await app.count("[data-kind=ask]")) === 1, 20_000), "a Work asks for an approval");
const asked = await q("window.__kiso.state.turns.length");
await q("document.querySelector('[data-act=new]').click()");
const notice = async () => readFileSync(notices, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
check(await waitUntil(async () => (await notice()).length === 1, 15_000) && asked === 1, "the person went to another Work: the approval is announced");
const [n] = await notice();
check(await waitUntil(() => q("window.__notes.length === 1"), 10_000) && (await q("JSON.stringify([window.__notes[0].title, window.__notes[0].body])")) === JSON.stringify(["kiso is waiting for you", `write_file in ${name(wsA)}`]), "the page shows it as a browser notification: the tool and the folder, never the content");
await q("window.__notes[0].onclick()");
check(await waitUntil(() => q(`document.activeElement?.dataset?.act === 'allow' && document.activeElement.closest('[data-decision]')?.dataset.decision === ${JSON.stringify(n.decisionId)}`), 10_000), "a click on the notification opens that Work and focuses that approval's Allow key");
await app.click("[data-act=allow]");
await app.close();

// the first-run guide: profiles but no sign-in
const data2 = scratch("guide-data");
const decoy = "sk-decoy-UI-NOT-IN-THE-PAGE-0123";
writeFileSync(join(data2, "config.json"), JSON.stringify({ model: "ds", models: { ds: { kind: "openai-compat", model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "HOME_PROOF_KEY_NAME" } } }));
const env2 = { ...process.env, KISO_WEB_FAUX: "", KISO_WEB_SESSION: "g1" };
delete env2.HOME_PROOF_KEY_NAME;
const g = await launchApp({ data: data2, workspace: scratch("guide-ws"), fauxScript: [], env: env2 });
const gq = (js) => g.evaluate(js);
check(await waitUntil(async () => (await g.count("[data-kind=guide]")) === 1) && (await g.count("[data-kind=composer]")) === 0, "no sign-in: the guide is shown in place of the input box");
await g.shot("guide");
await g.click("[data-profile=ds]");
const type = (text) => gq(`(() => { const el = document.querySelector('[data-field=key]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-act=save-key]').click(); })()`);
await type("short");
check(await waitUntil(async () => (await g.count(".pnote.warn")) === 1) && (await gq("document.querySelector('[data-field=key]').value")) === "", "a refused key says so, and the field is already empty");
await type(decoy);
check(await waitUntil(async () => (await g.count("[data-kind=guide]")) === 0 && (await g.count("[data-kind=composer]")) === 1), "a key that is kept ends the guide: the input box is back");
check(!(await gq("document.documentElement.outerHTML")).includes(decoy) && !(await gq("JSON.stringify([localStorage, sessionStorage])")).includes(decoy), "the key is nowhere in the page, its markup or its storage");
await g.close();
// the demo
const d = await launchApp({ data: scratch("demo-data"), workspace: scratch("demo-ws"), fauxScript: [], env: { KISO_WEB_FAUX: "", KISO_WEB_SESSION: "d1" } });
check(await waitUntil(async () => (await d.text("[data-kind=guide] h2")) !== null) && (await d.text("[data-kind=guide]")).includes("short demo"), "with no profile at all the guide offers the demo");
await d.click("[data-act=demo]");
check(await waitUntil(async () => (await d.count("[data-kind=composer]")) === 1), "starting it brings the input box");
await d.evaluate(`window.__kiso.send("show me around")`);
check(await waitUntil(async () => ((await d.text("[data-kind=answer]")) ?? "").includes("I see the workspace"), 25_000), "and the scripted tour runs: it looks at the folder, then answers");
await d.shot("demo");
await d.close();
verdict();
