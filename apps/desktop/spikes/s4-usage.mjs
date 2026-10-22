// Line 4: the usage frame against the terminal. The same faux script runs
// once through the real CLI (`kiso -p`, whose last line is the recap the
// owner reads: "fresh N out N · cache N%") and once through the desktop
// host; the run totals from the host's `run_usage` frame must agree.
//
// The CLI is the ORACLE here and is run as a process: nothing of it is
// imported, so the desktop's own code stays on public exports.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript } from "./lib.mjs";

const out = transcript("s4-usage");
const CLI = fileURLToPath(new URL("../../cli/dist/index.js", import.meta.url));

const use = (inputTokens, outputTokens, cacheRead) => ({ type: "usage", inputTokens, outputTokens, cacheRead, cacheWrite: null, known: true });
const scenarios = {
	// three calls, the middle one reported twice (the latest report is the call's)
	"three-calls-one-duplicated-report": [
		{ events: [{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} }, use(800, 30, 0), { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "tool_call_end", callId: "c2", name: "list_dir", input: {} }, use(900, 40, 512), use(900, 45, 512), { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "done" }, use(1000, 20, 896), { type: "stop", reason: "end_turn" }] },
	],
	// a large, cache-heavy run
	"cache-heavy": [
		{ events: [{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} }, use(41200, 310, 0), { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "tool_call_end", callId: "c2", name: "list_dir", input: {} }, use(41900, 280, 41088), { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "text_delta", text: "done" }, use(42500, 150, 41856), { type: "stop", reason: "end_turn" }] },
	],
};

// the terminal's number format, read off its recap: 1292 -> 1.3k, 42656 -> 42.7k, 130 -> 130
const fmt = (n) => (n < 1000 ? String(n) : `${(Math.round(n / 100) / 10).toFixed(1)}k`);

let allPass = true;
for (const [name, script] of Object.entries(scenarios)) {
	out(`=== ${name}`);
	// the terminal
	const home = scratch("s4-cli-home");
	const ws = scratch("s4-cli-ws");
	const scriptPath = join(home, "script.json");
	writeFileSync(scriptPath, JSON.stringify(script));
	let text;
	try {
		text = execFileSync(process.execPath, [CLI, "-p", "go"], { cwd: ws, env: { ...process.env, HOME: home, KISO_HOME: join(home, ".kiso"), KISO_FAUX_SCRIPT: scriptPath, NO_COLOR: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	} catch (e) {
		text = `${e.stdout ?? ""}${e.stderr ?? ""}`;
	}
	// the recap follows the answer on the same line
	const recap = /✦ took.*/.exec(text)?.[0] ?? "(no recap line)";
	out(`terminal : ${recap}`);
	const m = /fresh (\S+) out (\S+) · cache (\d+)%/.exec(recap);

	// the desktop host
	const data = scratch("s4-data");
	const workspace = scratch("s4-ws");
	const host = await launch({ data, workspace, fauxScript: script, env: { KISO_DESKTOP_ALLOW_ALL: "1" } });
	let total;
	const perCall = [];
	for await (const ev of clientFor(host).session("s4").runStream("go")) {
		if (ev.kind !== "frame") continue;
		if (ev.event === "usage") perCall.push(ev.data);
		if (ev.event === "run_usage") total = ev.data;
	}
	host.child.kill("SIGTERM");
	out(`host     : usage frames ${perCall.length}, run_usage ${JSON.stringify(total)}`);
	const mine = `fresh ${fmt(total.fresh)} out ${fmt(total.output)} · cache ${Math.round(total.cacheRate)}%`;
	out(`host as terminal would say: ${mine}`);
	const same = m !== null && m[1] === fmt(total.fresh) && m[2] === fmt(total.output) && Number(m[3]) === Math.round(total.cacheRate);
	out(`RESULT ${name}: ${same ? "PASS" : "FAIL"}`);
	allPass &&= same;
}
out(`ALL ${allPass ? "PASS" : "FAIL"}`);
