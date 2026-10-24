// The history across folders: Works of two folders listed newest first, a Work of another folder opened and resumed after kill -9, the guard on the new routes.
import { createClient } from "@vincemakes/kiso-client";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("history");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const slow = { events: [{ type: "delay", ms: 30_000 }, { type: "text_delta", text: "never" }, { type: "stop", reason: "end_turn" }] };
const data = scratch("history-data");
const [wsA, wsB] = [scratch("history-a"), scratch("history-b")];
const ask = async (host, id, text) => {
	const s = clientFor(host).session(id);
	await s.run(text);
	await waitUntil(async () => !(await s.state()).running, 8000);
};
const rows = async (host, fresh = "") => {
	const get = () => fetch(`${host.origin}/desk/history?fresh=${fresh}`, { headers: { authorization: `Bearer ${host.token}` } }).then((r) => r.json());
	await get();
	await waitUntil(async () => !(await get()).scanning, 8000);
	return get();
};

const a = await launch({ data, workspace: wsA, fauxScript: [say("A done.")] });
await ask(a, "work-a", "alpha task in folder A");
a.child.kill("SIGTERM");
await new Promise((r) => a.child.once("exit", r));
let b = await launch({ data, workspace: wsB, fauxScript: [say("B done."), slow] });
await ask(b, "work-b", "beta task in folder B");
let h = await rows(b);
check(h.works.map((w) => w.id).join() === "work-b,work-a", "both Works are listed across the two folders, newest first");
check(h.works.map((w) => w.title).join() === "beta task in folder B,alpha task in folder A", "each is titled by its first request");
check(h.current.key === h.works[0].key && h.works[0].key !== h.works[1].key && h.works.every((w) => w.state === "idle"), "the current folder is B's; the Works are idle");
const keyA = h.works[1].key;
const other = (host) => createClient({ baseUrl: `${host.origin}/w/${keyA}/v1/sessions`, headers: () => ({ authorization: `Bearer ${host.token}` }) }).session("work-a");
check((await other(b).replay()).events.some((e) => e.type === "text_delta" && e.text === "A done."), "a Work of the other folder replays through its folder's route");
await clientFor(b).session("work-b").run("beta second request, slow");
await waitUntil(async () => (await rows(b)).works[0].state === "running", 8000);
check(true, "a live run shows as running");
process.kill(b.pid, "SIGKILL");
await new Promise((r) => b.child.once("exit", r));
b = await launch({ data, workspace: wsB, fauxScript: [say("Resumed."), say("A again."), { events: [{ type: "tool_call_end", callId: "w1", name: "write_file", input: { path: "x.txt", content: "x" } }, { type: "stop", reason: "tool_use" }] }], env: { KISO_DESKTOP_MODE: "default" } });
const wb = clientFor(b).session("work-b");
check((await wb.state()).openRun !== null, "the killed run is an open run in its folder");
await wb.resume();
await waitUntil(async () => !(await wb.state()).running, 8000);
check((await wb.state()).openRun === null && (await wb.replay()).events.some((e) => e.type === "text_delta" && e.text === "Resumed."), "it resumes to its end");
const oa = other(b);
await oa.run("alpha again");
await waitUntil(async () => !(await oa.state()).running, 8000);
check((await oa.replay()).events.some((e) => e.type === "text_delta" && e.text === "A again."), "a Work of the other folder takes a new run from the host of this folder");
h = await rows(b, keyA);
check(h.works.find((w) => w.id === "work-b") !== undefined && h.works[0].id === "work-a" && h.works[0].runs === 2, "the history after the restart still holds both, the touched one first");
const call = (path, headers = {}) => fetch(`${b.origin}${path}`, { headers }).then((r) => r.status);
check((await call("/desk/history")) === 401 && (await call("/w/nope/v1/sessions/x/state", { authorization: `Bearer ${b.token}` })) === 404 && (await call("/desk/history", { authorization: `Bearer ${b.token}`, origin: "https://evil.example" })) === 403, "the new routes are guarded; an unknown folder key is 404");
await clientFor(b).session("work-c").run("write a file");
await waitUntil(async () => (await rows(b)).works.some((w) => w.state === "waiting"), 8000);
check((await rows(b)).works.find((w) => w.id === "work-c")?.state === "waiting", "a run that asks shows as waiting for the person");
b.child.kill("SIGKILL");
verdict();
