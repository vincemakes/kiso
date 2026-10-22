// The host carries the terminal's policy through the ./policy door: the
// catastrophe floor and the protected-file guards hold in every mode, the
// read-only shell runs unasked and the rest asks in `default`, and `plan`
// is read-only. Nothing here runs a shell command that could touch the
// home directory: the catastrophic target is this proof's own temporary
// workspace, and the "credential store" is a decoy file in a temporary
// KISO_HOME.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript, checker, sleep } from "./lib.mjs";

const out = transcript("policy");
const { check, verdict } = checker(out);
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const turn = (...events) => ({ events: [...events, { type: "stop", reason: "tool_use" }] });
const end = { events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] };

/** Run one scripted session in one mode; returns what the client saw. */
async function session(name, mode, makeScript, drive) {
	const home = realpathSync(scratch(`policy-${name}-home`));
	const workspace = realpathSync(scratch(`policy-${name}-ws`));
	mkdirSync(join(home, ".kiso"), { recursive: true });
	writeFileSync(join(home, ".kiso", "auth.json"), '{"version":1,"credentials":{"decoy":"DECOY-SECRET-VALUE"}}');
	writeFileSync(join(workspace, "a.txt"), "alpha\n");
	const host = await launch({ data: scratch(`policy-${name}-data`), workspace, fauxScript: makeScript({ home: join(home, ".kiso"), workspace }), env: { KISO_DESKTOP_MODE: mode, KISO_HOME: join(home, ".kiso") } });
	const s = clientFor(host).session(name);
	const seen = { wire: [], frames: [], workspace, home: join(home, ".kiso") };
	const ctl = new AbortController();
	const reader = (async () => {
		for await (const ev of s.events({ signal: ctl.signal })) {
			if (ev.kind === "event") seen.wire.push(ev.event);
			else if (ev.kind === "frame") seen.frames.push(ev);
		}
	})();
	await s.run("go");
	await drive?.(s, seen);
	for (let i = 0; i < 100 && (await s.state()).running; i++) await sleep(100);
	await sleep(300);
	ctl.abort();
	await reader;
	host.child.kill("SIGTERM");
	return seen;
}
const outputOf = (seen, callId) => seen.frames.find((f) => f.event === "tool_output" && f.data.callId === callId)?.data;
const text = (o) => (o?.head ?? []).join("\n");

out("=== full-access: the floor and the protected files still hold");
const fa = await session(
	"full",
	"full-access",
	({ home, workspace }) => [
		turn(call("f1", "shell", { command: `rm -rf ${workspace}` }), call("f2", "shell", { command: `cat ${home}/auth.json` }), call("f3", "read_file", { path: `${home}/auth.json` }), call("f4", "shell", { command: "echo fine" })),
		end,
	],
);
check(existsSync(fa.workspace), "the workspace survived `rm -rf <workspace>`");
check(outputOf(fa, "f1")?.isError === true && /floor/i.test(text(outputOf(fa, "f1"))), `the floor refused it: ${text(outputOf(fa, "f1")).slice(0, 90)}`);
check(outputOf(fa, "f2")?.isError === true && !/DECOY/.test(text(outputOf(fa, "f2"))), `shell naming the credential store is refused: ${text(outputOf(fa, "f2")).slice(0, 90)}`);
check(outputOf(fa, "f3")?.isError === true && !/DECOY/.test(text(outputOf(fa, "f3"))), "read_file of the credential store is refused");
check(text(outputOf(fa, "f4")) === "fine", "an ordinary command runs in full-access");
check(!JSON.stringify([fa.wire, fa.frames]).includes("DECOY-SECRET-VALUE"), "the decoy secret appears nowhere on the stream");
check(!fa.wire.some((e) => e.type === "permission_requested"), "full-access asks nothing");

out("=== default: the read-only shell runs unasked, the rest asks");
const df = await session(
	"default",
	"default",
	({ workspace }) => [
		turn(call("d1", "shell", { command: "ls" }), call("d2", "shell", { command: "touch made.txt" })),
		end,
	],
	async (s, seen) => {
		for (let i = 0; i < 50 && (await s.state()).pendingApprovals.length === 0; i++) await sleep(100);
		const pending = (await s.state()).pendingApprovals;
		seen.pending = pending;
		for (const p of pending) await s.approve(p.decisionId, false, "proof: deny");
	},
);
check(text(outputOf(df, "d1")).includes("a.txt"), "`ls` ran without asking");
check(df.pending.length === 1 && df.pending[0].name === "shell" && df.pending[0].input.command === "touch made.txt", "`touch made.txt` asked (one pending approval, with its command)");
check(!existsSync(join(df.workspace, "made.txt")), "the denied command did not run");

out("=== plan: read-only");
const pl = await session(
	"plan",
	"plan",
	() => [turn(call("p1", "read_file", { path: "a.txt" }), call("p2", "shell", { command: "touch made.txt" })), end],
);
check(text(outputOf(pl, "p1")).includes("alpha"), "plan: a read runs");
check(outputOf(pl, "p2")?.isError === true && /plan/i.test(text(outputOf(pl, "p2"))), `plan: a command is denied without asking: ${text(outputOf(pl, "p2")).slice(0, 80)}`);
check(!pl.wire.some((e) => e.type === "permission_requested") && !existsSync(join(pl.workspace, "made.txt")), "plan asks nothing and changes nothing");
verdict("policy");
