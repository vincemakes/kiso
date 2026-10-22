// Approvals, steer and abort over the client, in one session on the scripted model.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, sleep } from "./lib.mjs";

const { check, verdict } = checker("control");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const turn = (...events) => ({ events: [...events, { type: "stop", reason: "tool_use" }] });
const end = (text) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const workspace = scratch("control-ws");
writeFileSync(join(workspace, "a.txt"), "alpha\n");
const host = await launch({ data: scratch("control-data"), workspace, env: { KISO_DESKTOP_MODE: "default" }, fauxScript: [
	turn(call("a1", "shell", { command: "touch approved-run.txt" })), end("It ran."), // run 1: asks, approved
	turn(call("b1", "write_file", { path: "b.txt", content: "x" })), end("Not writing."), // run 2: asks, denied
	{ events: [{ type: "delay", ms: 1500 }, call("c1", "read_file", { path: "a.txt" }), { type: "stop", reason: "tool_use" }] }, end("Seen the steer."), // run 3: steered
	{ events: [{ type: "delay", ms: 2500 }, { type: "text_delta", text: "never shown" }, { type: "stop", reason: "end_turn" }] }, // run 4: aborted
] });
const s = clientFor(host).session("control");
const wire = [];
const ctl = new AbortController();
const reader = (async () => {
	for await (const ev of s.events({ signal: ctl.signal })) if (ev.kind === "event") wire.push(ev.event);
})();
const settle = async (ms = 8000) => {
	for (const stop = Date.now() + ms; Date.now() < stop && (await s.state()).running; await sleep(50));
};
const asked = async () => {
	for (let i = 0; i < 100 && (await s.state()).pendingApprovals.length === 0; i++) await sleep(50);
	return (await s.state()).pendingApprovals;
};
const err = (fn) => fn().then(() => null, (e) => `${e.status} ${e.code}`);

await s.run("run touch");
const [ask] = await asked();
const parked = await s.abort();
check(parked.kind === "parked" && parked.approvals.length === 1, "abort while parked is a refusal naming the approval, not an abort");
check((await s.approve(ask.decisionId, true)).needsResume === false, "approve resolves the live run");
await settle();
await s.run("write b.txt");
await s.approve((await asked())[0].decisionId, false, "not this file");
await settle();
check(["approved", "denied"].every((d) => wire.some((e) => e.type === "permission_decided" && e.decision === d)), "both decisions are on the stream");
check((await err(() => s.steer("too early"))) === "409 idle", "steer with no run: 409 idle");
await s.run("look at a.txt");
await sleep(400);
check((await s.steer("only the first line please")).runId !== undefined, "steer during a run is accepted");
await settle();
const at = wire.findIndex((e) => e.type === "user_input" && e.content === "only the first line please");
check(at > 0 && wire[at].source === "user" && wire.slice(0, at).some((e) => e.type === "tool_result"), "the steer is admitted as a user line after the tool result");
await s.run("think for a long time");
await sleep(500);
check((await s.abort()).kind === "stopped", "abort of a running turn: stopped");
await settle();
check(wire.at(-1).outcome?.kind === "aborted" && (await s.abort()).kind === "idle", "an aborted terminal; abort with nothing running: idle");
ctl.abort();
await reader;
host.child.kill("SIGTERM");
verdict();
