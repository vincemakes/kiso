// Line 7: approvals, steer and abort over the client — one transcript.
// One long-lived subscription prints every event and frame; the control
// calls are made from the main flow and logged between them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript, sleep, checker } from "./lib.mjs";

const out = transcript("s7-control");
const data = scratch("s7-data");
const workspace = scratch("s7-ws");
writeFileSync(join(workspace, "a.txt"), "alpha\n");

const script = [
	// run 1: shell asks; approved
	{ events: [{ type: "text_delta", text: "Running a command." }, { type: "tool_call_end", callId: "a1", name: "shell", input: { command: "touch approved-run.txt" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "It ran." }, { type: "stop", reason: "end_turn" }] },
	// run 2: write_file asks; denied with a reason
	{ events: [{ type: "tool_call_end", callId: "b1", name: "write_file", input: { path: "b.txt", content: "x" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Understood, not writing." }, { type: "stop", reason: "end_turn" }] },
	// run 3: steer lands while the model is "thinking" (1.5 s delay)
	{ events: [{ type: "delay", ms: 1500 }, { type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.txt" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Seen the steer." }, { type: "stop", reason: "end_turn" }] },
	// run 4: abort during a slow model turn
	{ events: [{ type: "delay", ms: 2500 }, { type: "text_delta", text: "never shown" }, { type: "stop", reason: "end_turn" }] },
];

const host = await launch({ data, workspace, fauxScript: script });
out(`host ${host.origin}`);
const s = clientFor(host).session("s7");
const t0 = Date.now();
const stamp = () => String(Date.now() - t0).padStart(6);
const ctl = new AbortController();
let lastApproval = null;
const reader = (async () => {
	for await (const ev of s.events({ signal: ctl.signal })) {
		if (ev.kind !== "event" && ev.kind !== "frame") continue;
		if (ev.kind === "frame") {
			if (ev.event !== "tasks") out(`${stamp()}ms    frame ${ev.event} ${JSON.stringify(ev.data).slice(0, 140)}`);
			continue;
		}
		const { seq, type, ...rest } = ev.event;
		wire.push(ev.event);
		if (type === "permission_requested") lastApproval = ev.event;
		out(`${stamp()}ms ${String(seq).padStart(3)} ${type} ${JSON.stringify(rest)}`.slice(0, 220));
	}
})();
const results = {};
const call = async (label, fn) => {
	try {
		const value = await fn();
		results[label] = { value };
		out(`${stamp()}ms >>> ${label} => ${JSON.stringify(value)}`);
	} catch (e) {
		results[label] = { error: { status: e.status, code: e.code } };
		out(`${stamp()}ms >>> ${label} => ERROR ${e.status ?? ""} ${e.code ?? ""} ${e.message}`);
	}
};
const wire = [];
const waitFor = async (pred, ms = 8000) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await pred()) return true;
		await sleep(50);
	}
	return false;
};
const idle = () => waitFor(async () => !(await s.state()).running);

out("--- run 1: shell asks, abort while parked is refused, approve");
await call("run", () => s.run("run echo"));
await waitFor(async () => (await s.state()).pendingApprovals.length > 0);
await call("state.pendingApprovals", async () => (await s.state()).pendingApprovals);
await call("abort (parked)", () => s.abort());
await call("approve(allow)", () => s.approve(lastApproval.decisionId, true));
await idle();

out("--- run 2: write_file asks, denied with a reason");
lastApproval = null;
await call("run", () => s.run("write b.txt"));
await waitFor(async () => (await s.state()).pendingApprovals.length > 0);
await call("approve(deny)", () => s.approve(lastApproval.decisionId, false, "not this file"));
await idle();

out("--- run 3: steer while the model is working");
await call("steer while idle", () => s.steer("too early"));
await call("run", () => s.run("look at a.txt"));
await sleep(400);
await call("steer", () => s.steer("only the first line please"));
await idle();

out("--- run 4: abort a running turn");
await call("run", () => s.run("think for a long time"));
await sleep(500);
const tAbort = Date.now();
await call("abort", async () => {
	const r = await s.abort();
	return { ...r, ms: Date.now() - tAbort };
});
await idle();
out(`${stamp()}ms abort -> idle in ${Date.now() - tAbort} ms`);
await call("abort (idle)", () => s.abort());
ctl.abort();
await reader;
host.child.kill("SIGTERM");

const { check, verdict } = checker(out);
const types = wire.map((e) => e.type);
check(results["abort (parked)"]?.value?.kind === "parked" && results["abort (parked)"].value.approvals.length === 1, "abort while parked is a refusal naming the approval, not an abort");
check(results["approve(allow)"]?.value?.needsResume === false, "approve resolves the live run (needsResume false)");
check(wire.some((e) => e.type === "permission_decided" && e.decision === "approved") && wire.some((e) => e.type === "permission_decided" && e.decision === "denied"), "both decisions are on the stream");
check(results["steer while idle"]?.error?.status === 409 && results["steer while idle"].error.code === "idle", "steer with no run is refused: 409 idle");
check(results.steer?.value?.runId !== undefined, "steer during a run is accepted");
const steerAt = wire.findIndex((e) => e.type === "user_input" && e.content === "only the first line please");
check(steerAt > 0 && wire[steerAt].source === "user" && wire.slice(0, steerAt).some((e) => e.type === "tool_result"), "the steer is admitted as a user line after the tool result");
check(results.abort?.value?.kind === "stopped", "abort of a running turn: stopped");
check(wire.at(-1).type === "terminal" && wire.at(-1).outcome.kind === "aborted", "the aborted run ends in an aborted terminal");
check(results["abort (idle)"]?.value?.kind === "idle", "abort with nothing running: idle");
verdict("control");
