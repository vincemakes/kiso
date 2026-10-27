// The home screen in the Electron window: the folder chip and the system picker (a proof answers from the environment, no dialog), the
// shortcut, a permission tier per Work, a notification's click opening its Work at its approval, and the first-run guide (a key typed into
// the field is gone from the page at once and never in its text). Screenshots go outside the repository.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchElectron, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("home-ui");
const [wsA, wsB] = [scratch("home-a"), scratch("home-b")];
const data = scratch("home-data");
const notices = join(data, "notices.jsonl");
writeFileSync(notices, "");
const app = await launchElectron({ data, workspace: wsA, env: { KISO_DESKTOP_SESSION: "h1", KISO_DESKTOP_PICK_FOLDER: wsB, KISO_DESKTOP_NOTIFY_LOG: notices }, fauxScript: [
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
check(await waitUntil(async () => (await chip()) === name(wsB)), "choosing opens an empty Work in the picked folder");
const before = await q("window.__kiso === undefined ? 0 : 1");
await q(`window.__kisoMark = window.__kiso; window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true })); true`);
check(await waitUntil(() => q("window.__kiso !== window.__kisoMark")) && before === 1, "the shortcut does the same: a new Work opens");
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
check(await waitUntil(async () => (await notice()).length === 1, 15_000) && asked === 1, "the person went to another Work: the approval is announced (the channel here is a file)");
const [n] = await notice();
await q(`window.__kisoOpenWork(${JSON.stringify({ key: n.key, sessionId: n.sessionId, decisionId: n.decisionId })})`);
check(await waitUntil(() => q(`document.activeElement?.dataset?.act === 'allow' && document.activeElement.closest('[data-decision]')?.dataset.decision === ${JSON.stringify(n.decisionId)}`), 10_000), "a click on the notification opens that Work and focuses that approval's Allow key");
await app.click("[data-act=allow]");
await app.close();

// the first-run guide: profiles but no sign-in
const data2 = scratch("guide-data");
const decoy = "sk-decoy-UI-NOT-IN-THE-PAGE-0123";
writeFileSync(join(data2, "config.json"), JSON.stringify({ model: "ds", models: { ds: { kind: "openai-compat", model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "HOME_PROOF_KEY_NAME" } } }));
const env2 = { ...process.env, KISO_DESKTOP_FAUX: "", KISO_DESKTOP_SESSION: "g1" };
delete env2.HOME_PROOF_KEY_NAME;
const g = await launchElectron({ data: data2, workspace: scratch("guide-ws"), fauxScript: [], env: env2 });
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
const d = await launchElectron({ data: scratch("demo-data"), workspace: scratch("demo-ws"), fauxScript: [], env: { KISO_DESKTOP_FAUX: "", KISO_DESKTOP_SESSION: "d1" } });
check(await waitUntil(async () => (await d.text("[data-kind=guide] h2")) !== null) && (await d.text("[data-kind=guide]")).includes("short demo"), "with no profile at all the guide offers the demo");
await d.click("[data-act=demo]");
check(await waitUntil(async () => (await d.count("[data-kind=composer]")) === 1), "starting it brings the input box");
await d.evaluate(`window.__kiso.send("show me around")`);
check(await waitUntil(async () => ((await d.text("[data-kind=answer]")) ?? "").includes("I see the workspace"), 25_000), "and the scripted tour runs: it looks at the folder, then answers");
await d.shot("demo");
await d.close();
verdict();
