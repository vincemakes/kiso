// Line 8: kill -9 the host (by its own PID) mid-run, restart it where the
// client expects it, resume, and check the client's one long-lived stream
// against the durable log: every wire event exactly once, none missing.
import { execFileSync } from "node:child_process";
import { createClient } from "@vincemakes/kiso-client";
import { launch, clientFor, scratch, transcript, sleep } from "./lib.mjs";

const out = transcript("s8-crash");
const data = scratch("s8-data");
const workspace = scratch("s8-ws");
const token = "spike-token-for-the-crash-test";

async function scenario(name, killAfterMs, firstScript, secondScript, afterRestart) {
	out(`=== scenario: ${name}`);
	const session = `s8-${name}`;
	const h1 = await launch({ data, workspace, fauxScript: firstScript, env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_TOKEN: token } });
	const port = h1.port;
	out(`host1 pid ${h1.pid} port ${port}`);
	const client = createClient({ baseUrl: `http://127.0.0.1:${port}/v1/sessions`, headers: () => ({ authorization: `Bearer ${token}` }), reconnect: { initialMs: 200, maxMs: 1000 } });
	const s = client.session(session);
	const t0 = Date.now();
	const stamp = () => String(Date.now() - t0).padStart(6);
	const seen = [];
	const ctl = new AbortController();
	const reader = (async () => {
		for await (const ev of s.events({ signal: ctl.signal, onReconnect: (n, w) => out(`${stamp()}ms     (client reconnect attempt ${n}, wait ${w} ms)`) })) {
			if (ev.kind !== "event") continue;
			seen.push(ev.event.seq);
			const { seq, type, ...rest } = ev.event;
			out(`${stamp()}ms ${String(seq).padStart(3)} ${type} ${JSON.stringify(rest)}`.slice(0, 200));
		}
	})();
	await s.run("go");
	await sleep(killAfterMs);
	// the children of the host we started: the shell command is detached and outlives it
	let orphans = [];
	try {
		orphans = execFileSync("pgrep", ["-P", String(h1.pid)]).toString().split("\n").filter(Boolean);
	} catch {
		// no children
	}
	out(`${stamp()}ms KILL -9 ${h1.pid} (children ${orphans.join(",") || "none"})`);
	process.kill(h1.pid, "SIGKILL");
	await new Promise((r) => h1.child.once("exit", r));
	await sleep(700); // the client is retrying against a closed port
	const h2 = await launch({ data, workspace, fauxScript: secondScript, fauxSkip: session, env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_TOKEN: token, KISO_DESKTOP_PORT: String(port) } });
	out(`${stamp()}ms host2 pid ${h2.pid} up on the same port; openRuns ${JSON.stringify(h2.openRuns)}`);
	out(`${stamp()}ms state ${JSON.stringify(await s.state())}`);
	await afterRestart(s, stamp);
	for (let i = 0; i < 100 && (await s.state()).running; i++) await sleep(100);
	// the client may still be in its backoff: wait until it has caught up to the log
	const high = (await s.state()).highWater;
	for (let i = 0; i < 100 && !seen.includes(Math.max(...(await s.replay()).events.map((e) => e.seq))); i++) await sleep(100);
	out(`${stamp()}ms client caught up (log high water ${high})`);
	ctl.abort();
	await reader;
	const replay = await s.replay();
	const durable = replay.events.map((e) => e.seq);
	const dups = seen.filter((q, i) => seen.indexOf(q) !== i);
	const missing = durable.filter((q) => !seen.includes(q));
	const extra = seen.filter((q) => !durable.includes(q));
	const ordered = seen.every((q, i) => i === 0 || q > seen[i - 1]);
	out(`RESULT ${name}: client saw ${seen.length} events, durable log has ${durable.length}; duplicates [${dups}] missing [${missing}] extra [${extra}] strictly-increasing ${ordered}`);
	const pass = dups.length === 0 && missing.length === 0 && extra.length === 0 && ordered;
	out(`RESULT ${name}: ${pass ? "PASS" : "FAIL"}`);
	if (!pass) process.exitCode = 1;
	for (const o of orphans) {
		try {
			process.kill(Number(o), "SIGKILL");
		} catch {
			// gone already
		}
	}
	h2.child.kill("SIGTERM");
	await new Promise((r) => h2.child.once("exit", r));
}

// A: killed while the model is mid-turn (some text already streamed)
await scenario(
	"mid-model",
	1200,
	[{ events: [{ type: "text_delta", text: "part one, " }, { type: "delay", ms: 6000 }, { type: "text_delta", text: "part two" }, { type: "stop", reason: "end_turn" }] }],
	[{ events: [{ type: "text_delta", text: "resumed answer" }, { type: "stop", reason: "end_turn" }] }],
	async (s, stamp) => {
		await s.run("again").catch((e) => out(`${stamp()}ms run without resumeFirst => ${e.status} ${e.code}`));
		out(`${stamp()}ms resume => ${JSON.stringify(await s.resume())}`);
	},
);

// B: killed while a tool is executing: the execution is uncertain
await scenario(
	"mid-tool",
	1500,
	[{ events: [{ type: "tool_call_end", callId: "k1", name: "shell", input: { command: "sleep 20; echo should-not-be-trusted" } }, { type: "stop", reason: "tool_use" }] }],
	// fauxSkip drops the turns the log consumed, so the script is the whole one
	[
		{ events: [{ type: "tool_call_end", callId: "k1", name: "shell", input: { command: "sleep 20; echo should-not-be-trusted" } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "I will not assume it ran." }, { type: "stop", reason: "end_turn" }] },
	],
	async (s, stamp) => {
		const st = await s.state();
		for (const u of st.uncertain) out(`${stamp()}ms resolveUncertain(${u.executionId}, abandoned) => ${JSON.stringify(await s.resolveUncertain(u.executionId, "abandoned"))}`);
		out(`${stamp()}ms resume => ${JSON.stringify(await s.resume())}`);
	},
);
