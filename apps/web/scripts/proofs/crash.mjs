// kill -9 the headless host (by its own pid) in the middle of a run, twice: while the model streams and while a tool executes.
// The host restarts where the client expects it; the client's one long-lived stream must end up with every durable wire event
// exactly once, in order.
import { execFileSync } from "node:child_process";
import { createClient } from "@vincemakes/kiso-client";
import { launch, scratch, checker, sleep, waitUntil } from "./lib.mjs";

const { check, verdict } = checker("crash");
const data = scratch("crash-data");
const workspace = scratch("crash-ws");
const token = "crash-proof-token";
const stop = { type: "stop", reason: "tool_use" };
const end = { type: "stop", reason: "end_turn" };

async function scenario(name, killAfterMs, first, second, afterRestart) {
	const session = `crash-${name}`;
	const env = { KISO_WEB_MODE: "full-access", KISO_WEB_TOKEN: token };
	const h1 = await launch({ data, workspace, fauxScript: first, env });
	const s = createClient({ baseUrl: `http://127.0.0.1:${h1.port}/v1/sessions`, headers: () => ({ authorization: `Bearer ${token}` }), reconnect: { initialMs: 200, maxMs: 800 } }).session(session);
	const seen = [];
	const ctl = new AbortController();
	const reader = (async () => {
		for await (const ev of s.events({ signal: ctl.signal })) if (ev.kind === "event") seen.push(ev.event.seq);
	})();
	await s.run("go");
	await sleep(killAfterMs);
	let orphans = [];
	try { orphans = execFileSync("pgrep", ["-P", String(h1.pid)]).toString().split("\n").filter(Boolean); } catch { /* no children */ }
	process.kill(h1.pid, "SIGKILL");
	await new Promise((r) => h1.child.once("exit", r));
	const h2 = await launch({ data, workspace, fauxScript: second, env: { ...env, KISO_WEB_PORT: String(h1.port), KISO_WEB_FAUX_SKIP: session } });
	check((await s.state()).openRun !== null, `${name}: the restarted host reports the open run`);
	await afterRestart(s);
	await waitUntil(async () => !(await s.state()).running && seen.includes(Math.max(...(await s.replay()).events.map((e) => e.seq))), 20_000);
	ctl.abort();
	await reader;
	const durable = (await s.replay()).events.map((e) => e.seq);
	const same = JSON.stringify(seen) === JSON.stringify(durable);
	check(same, `${name}: the client saw each of the ${durable.length} durable wire events exactly once, in order (no duplicate, no gap)${same ? "" : `: saw [${seen}], durable [${durable}]`}`);
	for (const pid of orphans) try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ }
	h2.child.kill("SIGTERM");
	await new Promise((r) => h2.child.once("exit", r));
}

await scenario("model", 1200, [{ events: [{ type: "text_delta", text: "part one, " }, { type: "delay", ms: 6000 }, { type: "text_delta", text: "part two" }, end] }], [{ events: [{ type: "text_delta", text: "resumed answer" }, end] }], async (s) => {
	check((await s.run("again").then(() => null, (e) => e.code)) === "open_run", "model: a new run is refused while the old one is open");
	await s.resume();
});
const sleeper = { events: [{ type: "tool_call_end", callId: "k1", name: "shell", input: { command: "sleep 20" } }, stop] };
await scenario("tool", 1500, [sleeper], [sleeper, { events: [{ type: "text_delta", text: "I will not assume it ran." }, end] }], async (s) => {
	const [u] = (await s.state()).uncertain;
	check(u !== undefined, "tool: the execution that was running is uncertain");
	await s.resolveUncertain(u.executionId, "abandoned");
	await s.resume();
});
verdict();
