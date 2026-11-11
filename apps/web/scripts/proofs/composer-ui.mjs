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
		if (body.includes("spent plan")) return void (res.writeHead(403, { "content-type": "application/json" }), res.end(JSON.stringify({ error: { message: "An active subscription is required to use this model." } })));
		// only a request whose LAST line asks it waits: every later request carries this one in its history
		const last = JSON.stringify(JSON.parse(body).messages.filter((m) => m.role === "user").at(-1) ?? "");
		if (last.includes("take your time")) await new Promise((r) => (slow = r));
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(chunk({ role: "assistant", content: "Seen." }) + chunk({}, "stop", { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }) + "data: [DONE]\n\n");
	});
});
await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${endpoint.address().port}`;
const home = scratch("comp-home");
mkdirSync(home, { recursive: true });
const profile = { kind: "openai-compat", baseUrl: `${origin}/v1`, apiKeyEnv: "MOCK_ENDPOINT_KEY" };
writeFileSync(join(home, "config.json"), JSON.stringify({ model: "text", models: { text: { ...profile, model: "mock-text" }, vision: { ...profile, model: "claude-sonnet-5-5" }, glm: { ...profile, model: "glm-5.3" } } }));
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
check((await app.count("[data-kind=images-held]")) === 0 && (await app.count("[data-kind=images-unknown]")) === 1 && /mock-text may not read pictures; they are sent/.test(await text("[data-kind=images-unknown]")) && !(await q("document.querySelector('[data-act=send]').disabled")), "on a model the table does not know, the picture is sent: one quiet line says so, and the line can go");
await app.shot("composer-1-held");
// a model the snapshot says is text-only (glm-5.3): the evidence holds the picture back, and Send cannot go
await app.click("[data-act=model]");
await app.click("[data-profile=glm]");
check(await waitUntil(async () => (await app.count("[data-kind=images-held]")) === 1 && (await app.count("[data-kind=images-unknown]")) === 0 && /glm-5\.3 does not read pictures/.test((await app.text("[data-kind=images-held]")) ?? "") && (await q("document.querySelector('[data-act=send]').disabled"))), "on a model the table says is text-only, the picture is held and the line cannot go");
await app.click("[data-act=model]");
await app.click("[data-profile=text]");
await waitUntil(async () => (await text("[data-field=model-pill]")) === "mock-text");

// switch this Work to the model that reads pictures, then send
await app.click("[data-act=model]");
// one line a model, the menu whole in the window, the model in use checked (owner 2026-11-03: the menu ran off the top)
const shape = await q("(() => { const m = document.querySelector('[data-menu=model]').getBoundingClientRect(); const rows = [...document.querySelectorAll('[data-menu=model] [data-profile]')]; return { inside: m.top >= 0 && m.bottom <= innerHeight, one: rows.every((r) => r.getBoundingClientRect().height < 40), checked: rows.find((r) => r.getAttribute('aria-checked') === 'true')?.dataset.profile }; })()");
check(shape.inside && shape.one && shape.checked === "text", `the model menu holds one line a model, sits whole in the window and checks the model in use (${JSON.stringify(shape)})`);
await app.click("[data-profile=vision]");
check(await waitUntil(async () => (await text("[data-field=model-pill]")) === "claude-sonnet-5-5" && (await app.count("[data-kind=images-unknown]")) === 0), "switching this Work to a model that reads pictures drops the line");
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
// the attached file is a card on the pictures' row, not text in the bubble; it opens in the viewer (owner 2026-11-03)
const bubble = await q("[...document.querySelectorAll('[data-kind=me]')].at(-1)?.textContent ?? ''");
check((await app.count('[data-kind=me-pictures] [data-file="errors.log"]')) === 1 && bubble === "what is in the picture?" && (await text('[data-file="errors.log"] small')) === "2 lines", `the file is a card beside the picture (its name and lines) and the bubble holds only the words ("${bubble}")`);
await app.shot("attachments-row");
const heights = await q("[...document.querySelectorAll('[data-kind=me-pictures] > button')].map((e) => Math.round(e.getBoundingClientRect().height))");
check(heights.length === 2 && new Set(heights).size === 1, `every attachment is one height, so the row reads as one (${heights.join(" / ")} px)`);
await app.click('[data-file="errors.log"]');
check(await waitUntil(async () => (await text("[data-kind=file-viewer] .fv-text")) === "line one\nline two\n"), "a click on the card shows its text in the viewer");
await q("dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true");
check(await waitUntil(async () => (await app.count("[data-kind=file-viewer]")) === 0), "Esc closes it");
await app.click("[data-act=tier]");
await app.click("[data-tier=accept-edits]");
check(await waitUntil(async () => (await text("[data-field=tier-pill]")) === "Edits allowed" && (await envMode()) === "accept-edits"), "with the Work started, the pill's tier is the Work's");

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
// a long line folds past six lines, fading; Show more opens it and Show less folds it again (owner 2026-11-03)
const footers = await app.count("[data-kind=footer]");
await q(`window.__kiso.send(${JSON.stringify(Array.from({ length: 12 }, (_, i) => `line ${i + 1} of a long message`).join("\n"))})`);
await waitUntil(async () => (await app.count("[data-act=me-more]")) === 1, 20_000);
const fold = () => q("(() => { const el = [...document.querySelectorAll('[data-kind=me]')].at(-1); return { h: el.clientHeight, full: el.scrollHeight, folded: el.classList.contains('folded'), label: document.querySelector('[data-act=me-more]')?.textContent }; })()");
const shut = await fold();
await app.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...(await q("(() => { const r = [...document.querySelectorAll('[data-kind=me]')].at(-1).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 20 }; })()")) });
check(await waitUntil(async () => +(await q("getComputedStyle([...document.querySelectorAll('[data-kind=me-acts]')].at(-1)).opacity")) === 1, 2000, 50), "over a long message's bubble (Show more between it and its actions) the Copy button shows");
await app.shot("long-message-folded");
await app.click("[data-act=me-more]");
const opened = await waitUntil(async () => (await fold()).label === "Show less" && (await fold()).h >= (await fold()).full - 1);
await app.click("[data-act=me-more]");
check(shut.folded && shut.h < shut.full / 1.5 && shut.label === "Show more" && opened && (await fold()).folded, `a twelve-line message shows about six (${shut.h} of ${shut.full} px), Show more opens it whole, Show less folds it again`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === footers + 1, 20_000);

// a refused request (a spent key or plan) is said under the run, with what the provider answered (owner 2026-11-03: the reply was blank)
await waitUntil(async () => (await app.count("[data-kind=footer]")) > 0 && (await q("document.querySelector('.cbar') !== null")), 20_000);
const ends = await app.count("[data-kind=run-end]");
await q(`window.__kiso.send("this hits a spent plan")`);
check(await waitUntil(async () => (await app.count("[data-kind=run-end][data-outcome=error]")) === ends + 1, 20_000) && /The run failed: .*403.*An active subscription is required/.test(await text("[data-kind=run-end][data-outcome=error]")), `a refused request says so under the run, with the provider's words ("${await text("[data-kind=run-end]")}")`);
await app.shot("run-end");

// a window of a million reads as the terminal writes it (owner 2026-11-03: not "1000k")
const ctxLine = () => q("document.querySelector('[data-field=context-pct]')?.parentElement.textContent.trim() ?? ''");
check(await waitUntil(async () => /\/ 1M$/.test(await ctxLine()), 15_000), `the rail writes this model's window of a million as 1M (${await ctxLine()})`);

// Settings' model field is the composer's menu too (owner 2026-11-03): each profile's model over its name, opening below its pill
if ((await q("document.querySelector('.win').dataset.side")) !== "1") await app.click("[data-act=sidebar]");
await app.click("[data-act=settings]");
await waitUntil(async () => (await app.count("[data-kind=settings] [data-act=profile]")) === 1, 15_000);
await app.click("[data-kind=settings] [data-act=profile]");
const listed = await q("[...document.querySelectorAll('[data-kind=settings] [data-menu=profile] .cm-i')].map((e) => e.querySelector('b').firstChild.textContent + '/' + e.querySelector('small').textContent).join()");
await sleep(400);
await app.shot("settings-model");
await app.click("[data-kind=settings] [data-profile=vision]");
check(listed === "mock-text/text,claude-sonnet-5-5/vision,glm-5.3/glm" && (await waitUntil(async () => (await text("[data-kind=settings] [data-field=profile]")) === "claude-sonnet-5-5")), `Settings lists each profile's model over its name in the composer's menu, and a pick shows in its pill (${listed})`);
endpoint.close();
await app.close();
verdict();
