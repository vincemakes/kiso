// `kiso-web` serves the page and a browser draws a whole run through kiso-client: signed in by the one-time code in the address (traded
// for a cookie and stripped from the address), a background: true command under its own task runner, the answer and the folded process.
import { scratch, checker, launchApp, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("browser");
const script = [
	{ events: [{ type: "thinking", text: "Plan: look at the folder." }, { type: "text_delta", text: "Looking." }, { type: "tool_call_end", callId: "e1", name: "list_dir", input: {} }, { type: "tool_call_end", callId: "e2", name: "shell", input: { command: "sleep 4; echo bg-done", background: true } }, { type: "usage", inputTokens: 900, outputTokens: 40, cacheRead: 0, cacheWrite: null, known: true }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "The workspace is **empty**." }, { type: "usage", inputTokens: 1000, outputTokens: 20, cacheRead: 800, cacheWrite: null, known: true }, { type: "stop", reason: "end_turn" }] },
];
const app = await launchApp({ data: scratch("br-data"), workspace: scratch("br-ws"), fauxScript: script, env: { KISO_WEB_MODE: "full-access", KISO_WEB_AUTORUN: "what is in the workspace?" } });
check(await waitUntil(async () => (await app.text("[data-kind=footer]")) !== null), "the page drew a whole run, up to its footer");
check((await app.count(".step[data-tool=shell] .bgtag")) === 1 && !(await app.text(".step[data-tool=shell]")).includes("did not record"), "a background: true command started its task runner");
check(await waitUntil(async () => / · finished · /.test((await app.text(".step[data-tool=shell] .s-req")) ?? ""), 10_000), "the task ended, and its card says finished");
check((await app.text("[data-kind=me]")) === "what is in the workspace?" && (await app.text("[data-kind=answer]")) === "The workspace is empty.", "the person's line and the answer");
check((await app.text("[data-kind=answer] b")) === "empty", "bold is an element, not asterisks");
check((await app.evaluate("document.querySelector('[data-kind=process]').dataset.folded")) === "true", "the process is folded after the run");
check(/in · .* out · \d+% cache/.test(await app.text("[data-kind=footer]")), "the footer");
check((await app.evaluate("location.hash")) === "" && (await app.evaluate("document.cookie")) === "", "the connect code is gone from the address, and the page cannot read its session cookie (HttpOnly)");
// the tab icon: every declared favicon is served with its type and the mark fills its square (the app-icon tile read in a tab as a dot)
const icons = await app.evaluate(`Promise.all([...document.querySelectorAll('link[rel=icon]')].map(async (l) => { const r = await fetch(l.href), img = new Image(); img.src = l.href; await img.decode(); const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.drawImage(img, 0, 0, 64, 64); const a = g.getImageData(0, 0, 64, 64).data; let lo = 64, hi = -1; for (let i = 0; i < 4096; i++) if (a[i * 4 + 3] > 40) (lo = Math.min(lo, i % 64, (i / 64) | 0)), (hi = Math.max(hi, i % 64, (i / 64) | 0)); return { href: new URL(l.href).pathname, status: r.status, type: r.headers.get('content-type'), fill: (hi - lo + 1) / 64, corner: a[3] }; }))`);
check(icons.length === 2 && icons.every((i) => i.status === 200 && /^image\/(svg\+xml|png)/.test(i.type) && i.fill >= 0.85 && i.corner === 0) && (await app.evaluate("document.querySelector('link[rel=apple-touch-icon]').getAttribute('href')")) === "/icon.png", `the tab icon fills its square (${icons.map((i) => `${i.href} ${i.status} ${i.type} ${Math.round(i.fill * 100)}%`).join(", ")}); the home-screen icon is still the tile`);
await app.close();
verdict();
