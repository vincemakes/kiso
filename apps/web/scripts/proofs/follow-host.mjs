// ADR-0062 Amendment 2 (owner, 2026-11-20): a Work follows the host that opens it. A Work the terminal made (a host with the
// sessions tools off, no mark) gains them when kiso web opens it with them on: the mark and the next revision are written once
// the Work's lock is held, the request's tool table is the one a web-born Work has, and a refused open (the terminal still
// holds the lock) writes nothing.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("follow-host");
const say = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const list = (callId) => ({ events: [{ type: "tool_call_end", callId, name: "list_sessions", input: {} }, { type: "stop", reason: "tool_use" }] });
const data = scratch("follow-host-data");
const ws = scratch("follow-host-ws");
const done = async (s, text) => (await s.run(text), await waitUntil(async () => !(await s.state()).running, 8000));
const stop = async (h) => (h.child.kill("SIGTERM"), await new Promise((r) => (h.child.exitCode !== null || h.child.signalCode !== null ? r() : h.child.once("exit", r))));

// the terminal-born Work: a host with the tools off
let host = await launch({ data, workspace: ws, fauxScript: [say("One.")] });
const key = (await fetch(`${host.origin}/desk/history`, { headers: { authorization: `Bearer ${host.token}` } }).then((r) => r.json())).current.key;
const dir = join(data, "projects", key);
const side = (id) => JSON.parse(readFileSync(join(dir, `${id}.meta.json`), "utf8"));
const trace = (id) => readFileSync(join(dir, "traces", `${id}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.toolSchemaHash !== undefined && r.purpose === undefined);
await done(clientFor(host).session("tb"), "start in the terminal");
await stop(host);
check(side("tb").sessionsTools !== true && side("tb").profile.revision === 1, "the terminal-born Work has no mark, revision 1");

// a live writer holds its lock (the terminal still has it open); the web opens it with the tools on
const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(join(dir, "tb.lock"), JSON.stringify({ pid: holder.pid, token: "the-terminal" }));
host = await launch({ data, workspace: ws, env: { KISO_WEB_SESSIONS: "on" }, fauxScript: [list("l1"), say("Listed."), say("Fresh.")] });
const before = JSON.stringify([side("tb").sessionsTools === true, side("tb").profile]);
await clientFor(host).session("tb").run("while the terminal holds it").catch(() => undefined);
await new Promise((r) => setTimeout(r, 1500));
check(JSON.stringify([side("tb").sessionsTools === true, side("tb").profile]) === before, "a refused open writes nothing: no mark, no revision");

// the terminal lets go (the holder dies: its lock is stale and taken over as before); now the run goes through
holder.kill("SIGKILL");
await new Promise((r) => holder.once("exit", r));
await stop(host); // the refused open poisoned the Work in this process (its log no longer matches the disk): opened again, as a person reloads it
host = await launch({ data, workspace: ws, env: { KISO_WEB_SESSIONS: "on" }, fauxScript: [list("l1"), say("Listed."), say("Fresh.")] });
const tb = clientFor(host).session("tb");
await done(tb, "now list the others");
check(side("tb").sessionsTools === true, "the web holds the lock: the Work is marked");
check(side("tb").profile.revision === 2 && side("tb").profile.tools.some((t) => t.name === "list_sessions"), "and the next revision records the tool table with the sessions tools");
const events = readFileSync(join(dir, "tb.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
const l1 = events.find((e) => e.type === "tool_result" && e.callId === "l1");
check(l1 !== undefined && !l1.isError, "list_sessions answers in the Work the terminal made");

// the bytes: a Work the web made has the same tool table in its requests
await done(clientFor(host).session("wb"), "a Work the web made");
const [a, b] = [trace("tb").at(-1), trace("wb").at(-1)];
check(a !== undefined && b !== undefined && a.toolSchemaHash === b.toolSchemaHash, `the converted Work's request carries the tool table a web-born Work's does (${a?.toolSchemaHash?.slice(0, 8)} / ${b?.toolSchemaHash?.slice(0, 8)})`);
check(side("wb").profile.revision === 1 && side("wb").sessionsTools === true, "a web-born Work is marked with revision 1, no second revision");
await stop(host);

// back in a host with the tools off: they are dropped, the next revision (monotone), unmarked; replay and a fork carry it
host = await launch({ data, workspace: ws, fauxScript: [say("Back.")] });
await done(clientFor(host).session("tb"), "and back");
check(side("tb").sessionsTools !== true && side("tb").profile.revision === 3 && !side("tb").profile.tools.some((t) => t.name === "list_sessions"), "a host without the tools drops them: unmarked, revision 3");
const replay = await clientFor(host).session("tb").state();
check(replay.running === false && (await fetch(`${host.origin}/v1/sessions/tb/state`, { headers: { authorization: `Bearer ${host.token}` } })).status === 200, "the Work replays after the switches");
host.child.kill("SIGKILL");
verdict();
