// The composer in a browser tab, against a local endpoint that records what it is sent (two profiles of the shared configuration:
// one whose model reads pictures, one the model table does not know to). The tier pill changes this Work's tier, and the rail says
// so once the Work has started; a pasted picture waits, unsent and named, while the model is not known to read it; a dropped text file becomes its text and a
// binary one is refused in words; switching this Work to the model that reads pictures lets the line go, and the endpoint receives
// the picture and the file's text under that model's id; the person's picture shows in their line and opens in the lightbox; `@`
// names a file of the folder; and a switch while a call is in flight is refused and put back. Screenshots go outside the repository.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("composer-ui");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const seen = [];
let slow = null;
const chunk = (delta, finish = null, usage) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
const endpoint = createServer((req, res) => {
	let body = "";
	req.on("data", (d) => (body += d));
	req.on("end", async () => {
		seen.push(JSON.parse(body));
		if (body.includes("take your time")) await new Promise((r) => (slow = r));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(chunk({ role: "assistant", content: "Seen." }) + chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) + "data: [DONE]\n\n");
	});
});
await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${endpoint.address().port}`;
const home = scratch("comp-home");
mkdirSync(home, { recursive: true });
const profile = { kind: "openai-compat", baseUrl: `${origin}/v1`, apiKeyEnv: "MOCK_ENDPOINT_KEY" };
writeFileSync(join(home, "config.json"), JSON.stringify({ model: "text", models: { text: { ...profile, model: "mock-text" }, vision: { ...profile, model: "claude-sonnet-5-5" } } }));
writeFileSync(join(home, "auth.json"), JSON.stringify({ version: 1, credentials: { [`endpoint:${origin}`]: { type: "api-key", key: "sk-test-0000", savedAt: 1 } } }));
const workspace = scratch("comp-ws");
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "src", "app.ts"), "export const app = 1;\n");
writeFileSync(join(workspace, "README.md"), "# comp\n");
const env = { ...process.env };
delete env.MOCK_ENDPOINT_KEY;
const app = await launchApp({ data: home, workspace, env: { ...env, KISO_HOME: home, KISO_WEB_MODE: "default", KISO_WEB_SESSION: "comp" } });
const q = (js) => app.evaluate(js);
const text = (sel) => app.text(sel).then((v) => v ?? "");
await waitUntil(async () => (await text("[data-field=model-pill]")) === "mock-text", 20_000);
check((await text("[data-field=tier-pill]")) === "Asks each time" && (await text("[data-field=model-pill]")) === "mock-text", "the bar under the box: this Work's tier and its model");

// the tier: this Work's, and the rail agrees
await app.click("[data-act=tier]");
check((await app.count("[data-tier]")) === 4, "the tier menu offers the four tiers");
await app.click("[data-tier=plan]");
const envMode = () => fetch(`${app.host().origin}/desk/env?session=comp`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json()).then((e) => e.mode);
check(await waitUntil(async () => (await text("[data-field=tier-pill]")) === "Read-only" && (await envMode()) === "plan"), "choosing Read-only changes this Work's tier (the host reads plan for this Work)");
await app.click("[data-act=tier]");
await app.click("[data-tier=default]");
await waitUntil(async () => (await text("[data-field=tier-pill]")) === "Asks each time");

// a picture pasted, a text file and a binary file dropped
const files = (list) => `(() => { const dt = new DataTransfer(); ${list} return dt; })()`;
const png = `new File([Uint8Array.from(atob('${PNG}'), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' })`;
await q(`document.querySelector('[data-kind=composer] textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: ${files(`dt.items.add(${png});`)}, bubbles: true, cancelable: true })); true`);
await q(`(() => { const dt = ${files("dt.items.add(new File(['line one\\nline two\\n'], 'errors.log', { type: 'text/plain' })); dt.items.add(new File([new Uint8Array([0, 1, 2, 0])], 'blob.bin'));")}; const box = document.querySelector('[data-kind=composer] .box'); box.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); box.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
check(await waitUntil(async () => (await app.count("[data-attachment=image]")) === 1 && (await app.count("[data-attachment=file]")) === 1), "a pasted picture and a dropped text file wait in the box");
check(/blob\.bin is not a text file/.test(await text("[data-kind=attach-note]")), "a dropped binary file is refused in words");
check((await app.count("[data-kind=images-held]")) === 1 && /mock-text is not known to read pictures/.test(await text("[data-kind=images-held]")) && (await q("document.querySelector('[data-act=send]').disabled")), "on a model not known to read pictures, the picture is held, named, and the line cannot go");
await app.shot("composer-1-held");

// switch this Work to the model that reads pictures, then send
await app.click("[data-act=model]");
await app.click("[data-profile=vision]");
check(await waitUntil(async () => (await text("[data-field=model-pill]")) === "claude-sonnet-5-5" && (await app.count("[data-kind=images-held]")) === 0), "switching this Work to a model that reads pictures lets them go");
const own = await fetch(`${app.host().origin}/desk/settings?session=comp`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json());
const others = await fetch(`${app.host().origin}/desk/settings`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json());
check(own.profile === "vision" && others.profile === "text", "the switch is this Work's only: new Works still start on the default");
await q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'what is in the picture?'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await app.click("[data-act=send]");
check(await waitUntil(async () => seen.length >= 1 && (await app.count("[data-kind=footer]")) === 1, 20_000), "the line went and the run ended");
const sent = JSON.stringify(seen.at(-1));
check(seen.at(-1).model === "claude-sonnet-5-5" && sent.includes(`data:image/png;base64,${PNG}`) && sent.includes("errors.log:\\n```\\nline one\\nline two") && sent.includes("what is in the picture?"), "the endpoint received the switched model's id, the picture, the file's text and the words");
check(await waitUntil(async () => (await q("document.querySelector('[data-kind=me-pictures] img')?.naturalWidth ?? 0")) === 1), "the person's picture shows in their line, read back from the log");
await app.click("[data-kind=me-pictures] button");
check(await waitUntil(async () => (await app.count("[data-kind=lightbox]")) === 1), "and opens in the lightbox");
await q("dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
await app.click("[data-act=tier]");
await app.click("[data-tier=accept-edits]");
check(await waitUntil(async () => (await text("[data-field=tier-pill]")) === "Edits allowed" && (await text("[data-field=tier]")) === "Edits allowed"), "with the Work started, the rail's footer follows the pill's tier");

// `@` names a file of the folder
await q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'look at @app'); el.selectionStart = el.selectionEnd = 12; el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
check(await waitUntil(async () => (await q("document.querySelector('[data-kind=at-picker] [data-at]')?.dataset.at ?? ''")) === "src/app.ts"), "`@app` lists src/app.ts from the folder");
await q(`document.querySelector('[data-kind=composer] textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
check(await waitUntil(async () => (await q("document.querySelector('[data-kind=composer] textarea').value")) === "look at @src/app.ts " && (await app.count("[data-kind=at-picker]")) === 0), "Enter puts the path in the line and closes the picker");
await app.shot("composer-2-sent");

// a switch while a call is in flight is refused, and the Work keeps its model
await q(`(() => { const el = document.querySelector('[data-kind=composer] textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(el, 'take your time'); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
await app.click("[data-act=send]");
await waitUntil(async () => slow !== null, 20_000);
const refused = await fetch(`${app.host().origin}/desk/settings`, { method: "POST", headers: { authorization: `Bearer ${app.host().token}` }, body: JSON.stringify({ session: "comp", profile: "text" }) });
const after = await fetch(`${app.host().origin}/desk/settings?session=comp`, { headers: { authorization: `Bearer ${app.host().token}` } }).then((r) => r.json());
check(refused.status === 409 && after.profile === "vision" && (await q("document.querySelector('[data-act=model]').disabled")), "while a call is in flight a switch is refused (409) and put back, and the pill is off");
slow();
await sleep(300);
endpoint.close();
await app.close();
verdict();
