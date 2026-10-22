// The host's run totals against the terminal's own recap line for the same scripted run (the terminal is run as a process).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launch, clientFor, scratch, checker } from "./lib.mjs";

const { check, verdict } = checker("usage");
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const list = (callId) => ({ type: "tool_call_end", callId, name: "list_dir", input: {} });
// three calls, the middle one reported twice (a call is its latest report)
const script = [
	{ events: [list("c1"), use(800, 30, 0), { type: "stop", reason: "tool_use" }] },
	{ events: [list("c2"), use(900, 40, 512), use(900, 45, 512), { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "done" }, use(1000, 20, 896), { type: "stop", reason: "end_turn" }] },
];
const home = scratch("usage-home");
writeFileSync(join(home, "script.json"), JSON.stringify(script));
const cli = fileURLToPath(new URL("../../../cli/dist/index.js", import.meta.url));
let text;
try {
	text = execFileSync(process.execPath, [cli, "-p", "go"], { cwd: scratch("usage-ws"), env: { ...process.env, HOME: home, KISO_HOME: join(home, ".kiso"), KISO_FAUX_SCRIPT: join(home, "script.json"), NO_COLOR: "1" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch (e) {
	text = `${e.stdout}${e.stderr}`;
}
const m = /fresh (\S+) out (\S+) · cache (\d+)%/.exec(/✦ took.*/.exec(text)?.[0] ?? "");
const host = await launch({ data: scratch("usage-data"), workspace: scratch("usage-hws"), fauxScript: script, env: { KISO_DESKTOP_MODE: "full-access" } });
let total;
for await (const ev of clientFor(host).session("usage").runStream("go")) if (ev.kind === "frame" && ev.event === "run_usage") total = ev.data;
host.child.kill("SIGTERM");
const fmt = (n) => (n < 1000 ? String(n) : `${(Math.round(n / 100) / 10).toFixed(1)}k`);
check(m !== null && m[1] === fmt(total.fresh) && m[2] === fmt(total.output) && Number(m[3]) === Math.round(total.cacheRate), `terminal "${m?.[0]}" and host fresh ${fmt(total.fresh)} out ${fmt(total.output)} cache ${Math.round(total.cacheRate)}% agree`);
verdict();
