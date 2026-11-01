// A hostile page in the Open panel. It tries, from its frame, to reach the host (fetch, img, script, form, top navigation, a
// window), another service on this machine, the Work's secrets (.env, .git, a key, a sibling directory by .. and by a link,
// node_modules), to list its directory, to write, and to read the cookie. Each attempt and its outcome is printed. Then the logs:
// the host received nothing from it, the other service nothing at all, and the preview server refused each forbidden path. Its
// headers, its Host check, and its end when the panel closes are read directly.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { checker, launchApp, scratch, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("preview-isolation");
const workspace = scratch("pi-ws");
const data = scratch("pi-data");
const [hostLog, previewLog] = [join(data, "requests.log"), join(data, "preview.log")];
for (const d of ["evil/.git", "evil/node_modules", "other"]) mkdirSync(join(workspace, d), { recursive: true });
for (const [f, text] of [[".env", "SECRET=1"], ["evil/.env", "SECRET=2"], ["evil/.git/config", "[core]"], ["evil/id_rsa", "KEY"], ["evil/node_modules/x.js", "1"], ["other/notes.txt", "sibling"]]) writeFileSync(join(workspace, f), text);
symlinkSync(join(workspace, "other"), join(workspace, "evil/link"));
let decoyHits = 0;
const decoy = createServer((_, res) => (decoyHits++, res.end("decoy"))).listen(0, "127.0.0.1");
await new Promise((r) => decoy.once("listening", r));
const app = await launchApp({ data, workspace, env: { KISO_WEB_SESSION: "pi", KISO_WEB_REQUEST_LOG: hostLog, KISO_WEB_PREVIEW_LOG: previewLog }, fauxScript: [{ events: [{ type: "text_delta", text: "The page is evil/index.html." }, { type: "stop", reason: "end_turn" }] }] });
const HOST = app.host().origin;
const DECOY = `http://localhost:${decoy.address().port}`;
writeFileSync(join(workspace, "evil/index.html"), `<!doctype html><title>Hostile</title><h1>Hostile</h1><script>
const out = [];
const tryFetch = async (what, url, init) => { try { const r = await fetch(url, init); out.push([what, "answered " + r.status]); } catch (e) { out.push([what, "failed: " + e.name]); } };
const tryLoad = (what, tag, url) => new Promise((done) => { const el = document.createElement(tag); el.onload = () => (out.push([what, "loaded"]), done()); el.onerror = () => (out.push([what, "failed: error event"]), done()); el.src = url; document.body.append(el); });
const tryDo = (what, fn) => { try { out.push([what, fn()]); } catch (e) { out.push([what, "failed: " + e.name]); } };
(async () => {
	await tryFetch("fetch the host's /v1 state", "${HOST}/v1/sessions/pi/state");
	await tryFetch("fetch the host's /desk/settings", "${HOST}/desk/settings");
	await tryFetch("POST the host's /auth/connect", "${HOST}/auth/connect", { method: "POST", body: "{}" });
	await tryLoad("img from the host", "img", "${HOST}/desk/settings");
	await tryLoad("script from the host", "script", "${HOST}/desk/settings");
	await tryFetch("fetch another service on localhost", "${DECOY}/");
	await tryLoad("img from another service on localhost", "img", "${DECOY}/x.png");
	tryDo("submit a form to the host", () => { const f = document.createElement("form"); f.method = "POST"; f.action = "${HOST}/auth/connect"; document.body.append(f); f.submit(); return "no error"; });
	await tryFetch(".env beside the page", "/.env");
	await tryFetch("the Work's .env, by ..", "/%2e%2e%2f.env");
	await tryFetch("a sibling directory, by ..", "/%2e%2e%2fother/notes.txt");
	await tryFetch("a sibling directory, by a link", "/link/notes.txt");
	await tryFetch(".git/config", "/.git/config");
	await tryFetch("a key-like name (id_rsa)", "/id_rsa");
	await tryFetch("node_modules", "/node_modules/x.js");
	await tryFetch("a listing of the page's directory", "/");
	await tryFetch("PUT over the page", "/index.html", { method: "PUT", body: "x" });
	tryDo("read document.cookie", () => "read " + JSON.stringify(document.cookie));
	tryDo("navigate the top window to the host", () => { top.location.href = "${HOST}/desk/settings"; return "no error"; });
	tryDo("open a window on the host", () => (open("${HOST}/desk/settings") === null ? "null" : "opened"));
	setTimeout(() => parent.postMessage({ page: "evil", out }, "*"), 1500);
})();
</script>`);
const q = (js) => app.evaluate(js);
await q(`window.__msgs = []; addEventListener("message", (e) => window.__msgs.push(e.data)); true`);
await q(`window.__kiso.send("open the page")`);
await waitUntil(async () => (await app.count("[data-chip]")) === 1, 20_000);
const before = readFileSync(hostLog, "utf8").split("\n").length;
await app.click("[data-chip]");
check(await waitUntil(async () => (await q("window.__msgs.some((m) => m.page === 'evil')")), 20_000), "the hostile page ran in the panel and reported its attempts");
const url = await q("document.querySelector('iframe.pageview').dataset.frame");
const port = Number(new URL(url).port);
const out = JSON.parse(await q("JSON.stringify(window.__msgs.find((m) => m.page === 'evil').out)"));
// what each attempt must come to: a request the browser stopped (CSP connect-src / img-src / script-src, or the sandbox), or a refusal by the preview server
// (a PUT is stopped at its CORS preflight: the server answers OPTIONS 405, so the page sees a failed fetch)
const EXPECT = {
	"fetch the host's /v1 state": /^failed/, "fetch the host's /desk/settings": /^failed/, "POST the host's /auth/connect": /^failed/, "img from the host": /^failed/, "script from the host": /^failed/,
	"fetch another service on localhost": /^failed/, "img from another service on localhost": /^failed/, "submit a form to the host": /./,
	".env beside the page": /^answered 403$/, "the Work's .env, by ..": /^answered 403$/, "a sibling directory, by ..": /^answered 403$/, "a sibling directory, by a link": /^answered 403$/,
	".git/config": /^answered 403$/, "a key-like name (id_rsa)": /^answered 403$/, node_modules: /^answered 403$/, "a listing of the page's directory": /^answered 404$/, "PUT over the page": /^(answered 405|failed: TypeError)$/,
	"read document.cookie": /^failed: SecurityError$/, "navigate the top window to the host": /./, "open a window on the host": /^null$/,
};
for (const [what, outcome] of out) check(EXPECT[what]?.test(outcome) === true, `attempt: ${what} -> ${outcome}`);
check(out.length === Object.keys(EXPECT).length, `every attempt reported (${out.length} of ${Object.keys(EXPECT).length})`);
await sleep(1000);
const during = readFileSync(hostLog, "utf8").split("\n").slice(before - 1).filter((l) => l !== "");
const fromPage = during.filter((l) => !/ site=(same-origin|none|-) origin=(-|http:\/\/127\.0\.0\.1:\d+) /.test(l) || / POST \/auth\/connect /.test(l) || / GET \/desk\/settings /.test(l));
for (const l of fromPage) console.log(`     host saw: ${l}`);
check(fromPage.length === 0, `the host received nothing from the page: of the ${during.length} requests in the window, every one came from the app's own page (same-origin), none was a form post, the settings read or a navigation`);
check(decoyHits === 0, "the other service on localhost received no request at all");
check((await q("location.origin")) === HOST, "the top window is still the app");
const refused = readFileSync(previewLog, "utf8").split("\n").filter((l) => / (403|404|405) /.test(l));
for (const l of refused) console.log(`     preview server: ${l}`);
check(["/.env 403 dot-file", "/%2e%2e%2f.env 403 dot-file", "/%2e%2e%2fother/notes.txt 403 dot-file", "/link/notes.txt 403 outside the root", "/.git/config 403 dot-file", "/id_rsa 403 key-like name", "/node_modules/x.js 403 node_modules", "GET / 404 no listing", "OPTIONS /index.html 405"].every((s) => refused.some((l) => l.includes(s))), "the preview server's log: each forbidden path refused, with its reason");
// read directly: the headers, the Host check (a rebinding name), and HEAD
const raw = (path, host, method = "GET") => new Promise((resolve, reject) => request({ host: "localhost", port, path, method, headers: { host } }, (res) => (res.resume(), resolve(res))).on("error", reject).end());
const page = await raw("/index.html", `localhost:${port}`);
const csp = page.headers["content-security-policy"];
check(csp === `sandbox allow-scripts; default-src 'self' 'unsafe-inline' https: data: blob:; connect-src 'self' https:; frame-ancestors ${HOST}` && page.headers["access-control-allow-origin"] === "*" && page.headers["x-content-type-options"] === "nosniff", `every response: ${csp}; ACAO *; nosniff`);
check((await raw("/index.html", `127.0.0.1:${port}`)).statusCode === 403 && (await raw("/index.html", `evil.example:${port}`)).statusCode === 403 && (await raw("/index.html", `localhost:${port}`, "HEAD")).statusCode === 200, "a request under another Host name is refused (DNS rebinding); HEAD is served");
check(/^http:\/\/localhost:\d+\//.test(url) && new URL(HOST).hostname === "127.0.0.1", "the preview is on localhost while the app is on 127.0.0.1: the browser never sends it the app's cookie");
await app.click("[data-act=panel-close]");
check(await waitUntil(async () => (await raw("/index.html", `localhost:${port}`).then((r) => r.statusCode, () => "closed")) === "closed"), "closing the panel closes its preview server");
decoy.close();
await app.close();
verdict();
