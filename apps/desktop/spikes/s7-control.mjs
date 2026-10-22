// Line 7: approvals, steer and abort over the client — one transcript.
// One long-lived subscription prints every event and frame; the control
// calls are made from the main flow and logged between them.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript, sleep } from "./lib.mjs";

const out = transcript("s7-control");
const data = scratch("s7-data");
const workspace = scratch("s7-ws");
writeFileSync(join(workspace, "a.txt"), "alpha\n");

const script = [
	// run 1: shell asks; approved
	{ events: [{ type: "text_delta", text: "Running a command." }, { type: "tool_call_end", callId: "a1", name: "shell", input: { command: "echo approved-run" } }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "It ran." }, { type: "stop", reason: "end_turn" }] },
	// run 2: write_file asks; denied with a reason
	{ events: [{ type: "tool_call_end", callId: "b1", name: "write_file", input: { path: "b.txt", content: "x", expectedRevision: "absent" } }, { type: "stop", reason: "tool_use" }] },
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
		if (type === "permission_requested") lastApproval = ev.event;
		out(`${stamp()}ms ${String(seq).padStart(3)} ${type} ${JSON.stringify(rest)}`.slice(0, 220));
	}
})();
const call = async (label, fn) => {
	try {
		out(`${stamp()}ms >>> ${label} => ${JSON.stringify(await fn())}`);
	} catch (e) {
		out(`${stamp()}ms >>> ${label} => ERROR ${e.status ?? ""} ${e.code ?? ""} ${e.message}`);
	}
};
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
