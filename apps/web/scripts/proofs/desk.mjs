// The page's own doors: picking a folder (validation, recents, a Work in it), a permission tier per Work, approval notices (once, only
// when the person is elsewhere, never the command), and the first-run guide's doors (a key stored through the terminal's file and never
// shown anywhere; the demo).
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("desk");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const turn = (...events) => ({ events: [...events, { type: "stop", reason: "tool_use" }] });
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const write = (callId, path) => turn(call(callId, "write_file", { path, content: "SECRET-CONTENT" }));
const data = scratch("desk-data");
const wsA = scratch("desk-a");
const wsB = scratch("desk-b");
const notices = join(data, "notices.jsonl");
writeFileSync(notices, "");
const host = await launch({ data, workspace: wsA, env: { KISO_WEB_NOTIFY_LOG: notices, KISO_WEB_MODE: "default" }, fauxScript: [
	write("a", "p1.txt"), say("one"), write("b", "p2.txt"), say("two"), // the tiers
	write("c", "p3a.txt"), write("d", "p3b.txt"), say("three"), // the approvals
] });
const api = (path, body, init = {}) => fetch(`${host.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${host.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...init }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const settled = async (s) => waitUntil(async () => !(await s.state()).running, 10_000);

// folders
const bad = [undefined, "", "/", "relative/dir", join(wsA, "nope"), join(wsA, "..", "..", "etc", "passwd\0x"), data, join(data, "projects")];
const statuses = [];
for (const p of bad) statuses.push((await api("/desk/folder", { path: p })).status);
writeFileSync(join(wsB, "afile"), "x");
statuses.push((await api("/desk/folder", { path: join(wsB, "afile") })).status);
check(statuses.every((s) => s === 400), `a folder is judged by the host: ${bad.length + 1} bad picks (missing, relative, NUL, a file, the whole disk, the kiso home and inside it) are 400`);
const picked = await api("/desk/folder", { path: wsB });
check(picked.status === 200 && picked.body.key !== undefined && picked.body.folder === wsB.split("/").pop(), "a real folder is accepted, canonical, and named");
const recent = (await api("/desk/recent")).body.recent;
check(recent.length === 1 && recent[0].key === picked.body.key && JSON.parse(readFileSync(join(data, "desktop.json"), "utf8")).recent.length === 1, "it is remembered as a recent folder in desktop.json");
const inB = clientFor(host);

// tiers
const s1 = inB.session("s1");
const s2 = inB.session("s2");
await api("/desk/settings", { mode: "plan", session: "s1" });
await api("/desk/settings", { mode: "full-access", session: "s2" });
await s1.run("write p1");
await settled(s1);
await s2.run("write p2");
await settled(s2);
const exists = (p) => { try { return statSync(join(wsA, p)).isFile(); } catch { return false; } };
check(!exists("p1.txt") && exists("p2.txt"), "two Works in one host: the same write is refused in the plan Work and runs in the full-access Work");
check((await api("/desk/settings?session=s1")).body.mode === "plan" && (await api("/desk/settings?session=s2")).body.mode === "full-access" && (await api("/desk/settings?session=other")).body.mode === "default", "each Work reports its own tier; a Work with none has the default");
await api("/desk/settings", { mode: "accept-edits" });
await api("/desk/settings", { mode: "no-such-tier", session: "s1" });
check((await api("/desk/settings?session=s1")).body.mode === "plan" && (await api("/desk/settings?session=zz")).body.mode === "accept-edits", "the default for new Works changes without touching a Work that has its own; an unknown tier is ignored");
await api("/desk/settings", { mode: "default" });

// approvals
const lines = () => readFileSync(notices, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const present = (focused, session) => api("/desk/presence", { key: "", session, focused });
const s3 = inB.session("s3");
await present(true, "s3");
await s3.run("write p3");
await waitUntil(async () => (await s3.state()).pendingApprovals.length === 1, 8000);
await sleep(2600);
check(lines().length === 0, "an approval that waits while the person is looking at that Work is not announced");
await present(false, "s3");
check(await waitUntil(async () => lines().length === 1, 5000), "the same approval, the person elsewhere: announced");
await sleep(2600);
const first = lines()[0];
check(lines().length === 1 && first.tool === "write_file" && first.folder === wsA.split("/").pop() && first.sessionId === "s3" && !JSON.stringify(first).includes("p3a") && !JSON.stringify(first).includes("SECRET"), "once only, with the tool and the folder and not what it was asked to write");
await s3.approve((await s3.state()).pendingApprovals[0].decisionId, true);
check(await waitUntil(async () => lines().length === 2, 8000) && lines()[1].decisionId !== first.decisionId, "the next approval is a new one and is announced");
await s3.approve((await s3.state()).pendingApprovals[0].decisionId, true);
await settled(s3);
const fb = clientFor({ ...host, origin: `${host.origin}/w/${picked.body.key}` }).session("fb");
await fb.run("hello in B").catch(() => null);
check((await api(`/desk/fs/tree?key=${picked.body.key}`)).body.root.endsWith(wsB.split("/").pop()), "a Work in the picked folder is served by that folder's own routes");
host.child.kill("SIGTERM");

// the first-run guide's doors, with no scripted model: a profile with no sign-in, a key stored, a demo
const home2 = scratch("desk-home2");
const decoy = "sk-decoy-DO-NOT-LEAK-0123456789";
writeFileSync(join(home2, "config.json"), JSON.stringify({ model: "ds", models: { ds: { kind: "openai-compat", model: "m", baseUrl: "http://127.0.0.1:9/v1", apiKeyEnv: "DESK_PROOF_KEY_NAME" } } }));
const env2 = { ...process.env, KISO_HOME: home2 };
delete env2.DESK_PROOF_KEY_NAME;
const h2 = await launch({ data: home2, workspace: scratch("desk-c"), env: env2 });
let seen = "";
for (const stream of [h2.child.stdout, h2.child.stderr]) stream.on("data", (d) => (seen += d));
const api2 = (path, body) => fetch(`${h2.origin}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${h2.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(async (r) => ({ status: r.status, text: await r.text() }));
const bodies = [];
const note = async (path, body) => (bodies.push(await api2(path, body)), bodies.at(-1));
check(JSON.parse((await note("/desk/settings")).text).setup === "signin", "profiles but no sign-in: the guide's state is signin");
const refusals = [await note("/desk/login", { profile: "ds", key: "short" }), await note("/desk/login", { profile: "ds", key: "has space inside it" }), await note("/desk/login", { profile: "nope", key: decoy })];
check(refusals.map((r) => r.status).join() === "400,400,404", "a bad key and an unknown profile are refused");
const ok = await note("/desk/login", { profile: "ds", key: decoy });
check(ok.status === 200 && ok.text === '{"ok":true}', "a key is stored and the answer is only ok");
check(JSON.parse((await note("/desk/settings")).text).setup === "ready" && readFileSync(join(home2, "auth.json"), "utf8").includes(decoy) && (statSync(join(home2, "auth.json")).mode & 0o777) === 0o600, "the guide's state becomes ready; the key is in the terminal's file, private");
await note("/desk/history");
await note("/desk/env");
await note("/desk/recent");
check(!bodies.some((b) => b.text.includes(decoy)) && !seen.includes(decoy), "the key is in no response of any door and in nothing the host printed");
await note("/desk/demo", {});
check(JSON.parse((await note("/desk/settings")).text).setup === "demo", "the demo can be started with no key");
let tour = "";
for await (const ev of clientFor(h2).session("tour").runStream("show me")) if (ev.kind === "event" && ev.event.type === "text_delta") tour += ev.event.text;
check(tour.includes("faux model"), "and runs the terminal's own scripted tour");
await note("/desk/login", { profile: "ds", key: decoy });
check(JSON.parse((await note("/desk/settings")).text).setup === "ready", "signing in ends the tour");
h2.child.kill("SIGTERM");
verdict();
