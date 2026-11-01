// What the wire and the host frames carry for a run with thinking, edits, a command and usage. `default`: the server's
// sanitizer and no thinking on the wire, to show what the web app's own settings add.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker } from "./lib.mjs";

const plain = process.argv[2] === "default";
const { check, verdict } = checker(plain ? "stream (server defaults)" : "stream (web settings)");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const OLD = "const retries = 3;\n".repeat(30);
const script = [
	{ events: ["Read first. ", "Then edit.\n\n", "Then check. ", "Done.\n\n", "Summarize."].map((text) => ({ type: "thinking", text })).concat([call("c1", "read_file", { path: "long.js" }), use(1000, 50, 0), { type: "stop", reason: "tool_use" }]) },
	{ events: [call("c2", "edit_file", { path: "long.js", edits: [{ oldText: OLD, newText: OLD.replaceAll("3", "5") }] }), call("c4", "write_file", { path: "notes.md", content: "# Notes\n".repeat(60) }), call("c3", "shell", { command: "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo line $i; done" }), use(1600, 80, 1000), { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "text_delta", text: "Done." }, use(1900, 20, 1600), { type: "stop", reason: "end_turn" }] },
];
const workspace = scratch("stream-ws");
writeFileSync(join(workspace, "long.js"), OLD);
const host = await launch({ data: scratch("stream-data"), workspace, fauxScript: script, env: { KISO_WEB_MODE: "full-access", KISO_WEB_SANITIZER: plain ? "default" : "web", KISO_WEB_THINKING: plain ? "0" : "1" } });
const wire = [];
const frames = [];
for await (const ev of clientFor(host).session("stream").runStream("change it")) (ev.kind === "event" ? wire : frames).push(ev.kind === "event" ? ev.event : ev);
host.child.kill("SIGTERM");
const of = (name) => frames.filter((f) => f.event === name).map((f) => f.data);
const edit = wire.find((e) => e.name === "edit_file");
const write = wire.find((e) => e.name === "write_file");
check(!wire.some((e) => e.type === "usage"), "usage is not a wire event");
if (plain) {
	check(!wire.some((e) => e.type === "thinking"), "thinking is off the wire unless asked for");
	check(edit.input.edits[0].oldText.length <= 201 && write.input.content === undefined, "the default sanitizer cuts edit text at 200 characters and drops write_file content");
} else {
	check(wire.filter((e) => e.type === "thinking").length === 5, "thinking reaches the client");
	check(edit.input.edits[0].oldText.length === 570 && edit.input.edits[0].newText.length === 570 && write.input.content.length === 480, "edit_file text and write_file content arrive whole");
	const ats = of("at");
	check(ats.length >= 8 && ats.every((a, i) => (i === 0 || a.ts >= ats[i - 1].ts) && wire.some((e) => e.seq === a.seq)), `at frames: ${ats.length}, nondecreasing, each names a wire event`);
	const total = of("run_usage")[0];
	check(of("usage").length === 3 && total.fresh === 1900 && total.cacheRead === 2600 && Math.abs(total.cacheRate - 57.78) < 0.01, `usage frames and run_usage: ${total.fresh} fresh, ${total.cacheRead} cache`);
	const sh = of("tool_output").find((o) => o.lines === 15);
	check(of("tool_output").length === 4 && sh.head.length === 12 && sh.truncated, "a tool_output frame per result; 15 lines of output arrive as the first 12");
}
verdict();
