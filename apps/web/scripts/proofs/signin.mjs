// The doors W1 added to the host: the sign-in (a one-time connect code traded for an HttpOnly cookie named after the port, sessions kept
// hashed in web.json, revoked from the command, the Host and Origin checks still on), the fixed port (another kiso-web on it: its page
// is opened; anything else: an error naming the process), a remembered folder that is gone, and the folder browser (folders only, a link
// never leads out of the root, the whole disk and the kiso home refused).
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, scratch, checker } from "./lib.mjs";

const { check, verdict } = checker("signin");
const cli = fileURLToPath(new URL("../../dist/main/headless.js", import.meta.url));
const [data, home, other] = ["si-data", "si-home", "si-other"].map((l) => realpathSync(scratch(l)));
for (const d of ["a/deep", "b", ".hidden"]) mkdirSync(join(home, d), { recursive: true });
writeFileSync(join(home, "f.txt"), "a file");
symlinkSync(join(home, "a"), join(home, "link-in"));
symlinkSync(other, join(home, "link-out"));
const gone = scratch("si-gone");
writeFileSync(join(data, "desktop.json"), JSON.stringify({ lastFolder: gone }));
rmSync(gone, { recursive: true });
const host = await launch({ data, workspace: "", fauxScript: [], env: { HOME: home } });
const at = (path, { cookie, origin, site, body, method = body === undefined ? "GET" : "POST", bearer } = {}) =>
	fetch(`${host.origin}${path}`, { method, headers: { ...(cookie && { cookie }), ...(origin && { origin }), ...(site && { "sec-fetch-site": site }), ...(bearer && { authorization: `Bearer ${host.token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const code = new URL(host.connect).hash.slice(3);
check((await at("/auth/connect", { body: { code } })).status === 403 && (await at("/auth/connect", { body: { code }, origin: "http://127.0.0.1:1" })).status === 403, "a code is traded only from the page's own origin");
const traded = await at("/auth/connect", { body: { code }, origin: host.origin });
const setCookie = traded.headers.get("set-cookie") ?? "";
const cookie = setCookie.split(";")[0];
check(traded.status === 200 && cookie.startsWith(`kiso_web_${host.port}=`) && /HttpOnly/.test(setCookie) && /SameSite=Strict/.test(setCookie) && /Path=\//.test(setCookie) && /Max-Age=\d{7,}/.test(setCookie), "the code becomes a lasting cookie: named after the port, HttpOnly, SameSite=Strict, Path=/");
check((await at("/auth/connect", { body: { code }, origin: host.origin })).status === 401 && (await at("/auth/connect", { body: { code: "made-up" }, origin: host.origin })).status === 401, "a code works once; a made-up code not at all");
const state = "/v1/sessions/s/state";
check((await at(state, { cookie })).status === 200 && (await at("/desk/env", { cookie, site: "same-origin" })).status === 200, "the cookie opens the routes");
check((await at(state, { cookie, origin: "http://127.0.0.1:9999" })).status === 403, "the cookie from another page (another port of 127.0.0.1 is the same site): refused by the Origin check");
check((await at(state, { cookie, site: "same-site" })).status === 401 && (await at(state, { cookie: `kiso_web_1${cookie.slice(cookie.indexOf("="))}` })).status === 401 && (await at(state, { cookie: `${cookie}x` })).status === 401, "a request another page sent, a cookie of another port's name, a wrong value: refused");
const web = join(data, "web.json");
check((statSync(web).mode & 0o777) === 0o600 && !readFileSync(web, "utf8").includes(cookie.split("=")[1]) && JSON.parse(readFileSync(web, "utf8")).sessions.length === 1, "web.json is private and keeps only a hash of the session");
check((await (await at("/auth/status", { cookie })).json()).signedIn === true && (await (await at("/auth/status")).json()).signedIn === false, "the status door tells a signed-in page from one that is not");
check((await at("/auth/code", { method: "POST" })).status === 401 && (await at("/auth/code", { method: "POST", cookie })).status === 401, "a fresh code needs the scripts' token, not a cookie");
// the fixed port: a second kiso-web on it hands out a fresh code of the running host; a stranger on a port is named
const env = { ...process.env, KISO_HOME: data, KISO_WEB_DATA: data };
const again = spawnSync(process.execPath, [cli, "--no-open", "--port", String(host.port)], { env, encoding: "utf8" });
const fresh = /#c=([\w-]+)/.exec(again.stdout)?.[1];
check(again.status === 0 && /already running/.test(again.stdout) && fresh !== undefined && (await at("/auth/connect", { body: { code: fresh }, origin: host.origin })).status === 200, "kiso-web on a port its host holds: no second host, a fresh code of the running one that signs in");
const stranger = createServer((_, res) => res.end("hello")).listen(0, "127.0.0.1");
await new Promise((r) => stranger.once("listening", r));
const held = spawnSync(process.execPath, [cli, "--no-open", "--port", String(stranger.address().port)], { env, encoding: "utf8" });
check(held.status === 1 && held.stderr.includes(`is held by node (pid ${process.pid})`), `a port held by another program: an error naming it (${held.stderr.trim()})`);
stranger.close();
check(!/[0-9a-f]{32}/.test(again.stdout + held.stdout + held.stderr) && !(await at("/desk/settings", { bearer: true }).then((r) => r.text())).includes(host.token), "the scripts' token is printed nowhere");
const revoked = spawnSync(process.execPath, [cli, "--revoke-sessions"], { env, encoding: "utf8" });
check(revoked.status === 0 && /2 session\(s\) revoked/.test(revoked.stdout) && (await at(state, { cookie })).status === 401 && (await (await at("/auth/status", { cookie })).json()).signedIn === false, "--revoke-sessions: the running host refuses the cookie at once");
// a remembered folder that is gone: the home folder
check((await (await at("/desk/env", { bearer: true })).json()).path === home, "a remembered folder that no longer exists falls back to the home folder");
// the folder browser
const dirs = async (q) => {
	const r = await at(`/desk/dirs?${new URLSearchParams(q)}`, { bearer: true });
	return { status: r.status, ...(await r.json()) };
};
const top = await dirs({});
check(top.status === 200 && top.root === home && JSON.stringify(top.dirs) === JSON.stringify([{ name: "a" }, { name: "b" }, { name: "link-in" }, { name: "link-out", outside: true }]), "home: folders only, no file, no dot folder; a link out of home is marked and a link inside is a folder");
check((await dirs({ path: "link-in" })).full === join(home, "a") && (await dirs({ path: "a" })).dirs[0]?.name === "deep", "a folder opens one level at a time, through a link that stays inside");
const refused = await Promise.all([dirs({ path: "link-out" }), dirs({ path: "../" }), dirs({ path: "/etc" }), dirs({ root: "/" }), dirs({ root: join(home, "nope") }), dirs({ root: "relative" }), dirs({ root: data })]);
check(refused.map((r) => r.status).join() === "403,400,400,400,400,400,400", `refused: a link out, .., an absolute path, the whole disk, a missing root, a relative root, the kiso home (${refused.map((r) => r.status)})`);
const typed = await dirs({ root: join(home, "link-out") });
check(typed.status === 200 && typed.root === other && typed.full === other, "a typed path is another root, by its real path");
host.child.kill("SIGTERM");
verdict();
