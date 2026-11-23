// A deleted Work stays deleted: its tombstone answers 404 to any session request, before or after a restart, and nothing of
// it is made again (no log, lock, meta or inbox), however it is asked (a tab still open, a poll, a Desk call). A new Work is
// created as before.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("deleted-work");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const data = scratch("deleted-work-data");
const ws = scratch("deleted-work-ws");
const script = [say("One."), say("Two."), say("Three.")];
let host = await launch({ data, workspace: ws, fauxScript: script });
const auth = () => ({ authorization: `Bearer ${host.token}` });
const key = (await fetch(`${host.origin}/desk/history`, { headers: auth() }).then((r) => r.json())).current.key;
const dir = join(data, "projects", key);
const left = () => readdirSync(dir).filter((f) => f.startsWith("wx."));
const desk = (body) => fetch(`${host.origin}/desk/work`, { method: "POST", headers: auth(), body: JSON.stringify(body) });

const wx = clientFor(host).session("wx");
await wx.run("first");
await waitUntil(async () => !(await wx.state()).running, 8000);
check(left().some((f) => f === "wx.jsonl"), "the Work exists before the delete");
const trace = join(dir, "traces", "wx.jsonl"); // the request ledger lives beside the log, not in it
check(existsSync(trace), "its request trace exists before the delete");
check((await desk({ session: "wx", act: "delete" })).status === 200, "the Work is deleted");
check(left().length === 0, `its files are gone (${left().join(",") || "none"})`);
check(!existsSync(trace), "its request trace is gone too");

// a tab still open asks for it: the snapshot, the stream, a run
const state = await fetch(`${host.origin}/v1/sessions/wx/state`, { headers: auth() });
const events = await fetch(`${host.origin}/v1/sessions/wx/events`, { headers: auth() });
const run = await fetch(`${host.origin}/v1/sessions/wx/run`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify({ input: "again" }) });
check(state.status === 404 && events.status === 404 && run.status === 404, `state, events and run answer 404 (${state.status} ${events.status} ${run.status})`);
await desk({ session: "wx", act: "pin" }).catch(() => undefined); // a Desk call naming it
check(left().length === 0, `nothing of it is made again: no log, lock, meta or inbox (${left().join(",") || "none"})`);

// after a restart: the same
host.child.kill("SIGKILL");
await new Promise((r) => (host.child.exitCode !== null || host.child.signalCode !== null ? r() : host.child.once("exit", r)));
host = await launch({ data, workspace: ws, fauxScript: script });
const again = await fetch(`${host.origin}/v1/sessions/wx/state`, { headers: auth() });
check(again.status === 404 && left().length === 0, `after a restart it still answers 404 and nothing is made (${again.status}; ${left().join(",") || "none"})`);

// a new Work is created as before
const wy = clientFor(host).session("wy");
await wy.run("hello");
await waitUntil(async () => !(await wy.state()).running, 8000);
check(existsSync(join(dir, "wy.jsonl")) && (await fetch(`${host.origin}/v1/sessions/wy/state`, { headers: auth() })).status === 200, "a new Work is created and read as before");
host.child.kill("SIGKILL");
verdict();
