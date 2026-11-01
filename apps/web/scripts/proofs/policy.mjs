// The terminal's policy through the host (the ./policy door): the floor and the protected files hold in every mode,
// `default` runs the read-only shell unasked and asks for the rest, `plan` is read-only. Nothing here can touch the home
// directory: the target of `rm -rf` is this proof's own temporary workspace, the credential store a decoy in a temporary KISO_HOME.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, sleep } from "./lib.mjs";

const { check, verdict } = checker("policy");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const turn = (...events) => ({ events: [...events, { type: "stop", reason: "tool_use" }] });
const end = { events: [{ type: "text_delta", text: "done" }, { type: "stop", reason: "end_turn" }] };

/** One scripted session in one mode; returns what the client saw. */
async function session(name, mode, makeScript, drive) {
	const home = join(realpathSync(scratch(`policy-${name}`)), ".kiso");
	const workspace = realpathSync(scratch(`policy-${name}-ws`));
	mkdirSync(home);
	writeFileSync(join(home, "auth.json"), '{"credentials":{"decoy":"DECOY-SECRET-VALUE"}}');
	writeFileSync(join(workspace, "a.txt"), "alpha\n");
	const host = await launch({ data: scratch(`policy-${name}-data`), workspace, fauxScript: makeScript({ home, workspace }), env: { KISO_WEB_MODE: mode, KISO_HOME: home } });
	const s = clientFor(host).session(name);
	const seen = { wire: [], frames: [], workspace };
	const ctl = new AbortController();
	const reader = (async () => {
		for await (const ev of s.events({ signal: ctl.signal })) (ev.kind === "event" ? seen.wire : seen.frames).push(ev.kind === "event" ? ev.event : ev);
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
const out = (seen, id) => seen.frames.find((f) => f.event === "tool_output" && f.data.callId === id)?.data;
const said = (seen, id) => (out(seen, id)?.head ?? []).join("\n");

const fa = await session("full", "full-access", ({ home, workspace }) => [turn(call("f1", "shell", { command: `rm -rf ${workspace}` }), call("f2", "shell", { command: `cat ${home}/auth.json` }), call("f3", "read_file", { path: `${home}/auth.json` }), call("f4", "shell", { command: "echo fine" })), end]);
check(existsSync(fa.workspace) && /floor/i.test(said(fa, "f1")), "full-access: the floor refuses `rm -rf <workspace>` and the workspace survives");
check(out(fa, "f2").isError && out(fa, "f3").isError && !JSON.stringify([fa.wire, fa.frames]).includes("DECOY"), "full-access: the credential store is refused to shell and read_file, and nowhere on the stream");
check(said(fa, "f4") === "fine" && !fa.wire.some((e) => e.type === "permission_requested"), "full-access: an ordinary command runs unasked");

const df = await session("default", "default", () => [turn(call("d1", "shell", { command: "ls" }), call("d2", "shell", { command: "touch made.txt" })), end], async (s, seen) => {
	for (let i = 0; i < 50 && (await s.state()).pendingApprovals.length === 0; i++) await sleep(100);
	seen.pending = (await s.state()).pendingApprovals;
	for (const p of seen.pending) await s.approve(p.decisionId, false, "proof: deny");
});
check(said(df, "d1").includes("a.txt"), "default: `ls` ran without asking");
check(df.pending.length === 1 && df.pending[0].input.command === "touch made.txt" && !existsSync(join(df.workspace, "made.txt")), "default: `touch` asked once, and denied it did not run");

const pl = await session("plan", "plan", () => [turn(call("p1", "read_file", { path: "a.txt" }), call("p2", "shell", { command: "touch made.txt" })), end]);
check(said(pl, "p1").includes("alpha") && out(pl, "p2").isError && /plan/i.test(said(pl, "p2")), "plan: a read runs, a command is denied");
check(!pl.wire.some((e) => e.type === "permission_requested") && !existsSync(join(pl.workspace, "made.txt")), "plan: nothing asked, nothing changed");
verdict();
