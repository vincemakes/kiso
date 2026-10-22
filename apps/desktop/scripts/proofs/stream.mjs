// Lines 2, 3, 4 and 6 over the loopback: a faux run with thinking in
// paragraphs, an edit_file call, a shell call, and usage with cache reads.
// Prints the client's view of every event and frame.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript, checker } from "./lib.mjs";

const out = transcript(process.argv[2] === "default" ? "s6-default-sanitizer" : "s23-stream");
const sanitizer = process.argv[2] === "default" ? "default" : "desktop";
const data = scratch("s23-data");
const workspace = scratch("s23-ws");
writeFileSync(join(workspace, "greeting.txt"), "hello world\nsecond line\n");

const longOld = "const retries = 3;\n".repeat(30);
const longNew = "const retries = 5;\n".repeat(30);
writeFileSync(join(workspace, "long.js"), longOld);

const think = (t) => ({ type: "thinking", text: t });
const script = [
	{
		events: [
			think("The user wants the greeting changed."),
			think(" I should read the file first.\n\n"),
			think("Then I will edit it, and run a command to confirm."),
			think(" That is the whole plan.\n\n"),
			think("Finally I will summarize."),
			{ type: "text_start" },
			{ type: "text_delta", text: "Reading, editing, then checking." },
			{ type: "text_end" },
			{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "greeting.txt" } },
			{ type: "tool_call_end", callId: "c0", name: "read_file", input: { path: "long.js" } },
			{ type: "usage", inputTokens: 1000, outputTokens: 50, cacheRead: 0, cacheWrite: null, known: true },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "tool_call_end", callId: "c2", name: "edit_file", input: { path: "long.js", edits: [{ oldText: longOld, newText: longNew }] } },
			{ type: "tool_call_end", callId: "c4", name: "write_file", input: { path: "notes.md", content: "# Notes\n".repeat(60) } },
			{ type: "tool_call_end", callId: "c3", name: "shell", input: { command: "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do echo line $i; done" } },
			{ type: "usage", inputTokens: 1600, outputTokens: 80, cacheRead: 1000, cacheWrite: null, known: true },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{
		events: [
			{ type: "text_delta", text: "Done." },
			{ type: "usage", inputTokens: 1900, outputTokens: 20, cacheRead: 1600, cacheWrite: null, known: true },
			{ type: "stop", reason: "end_turn" },
		],
	},
];

const host = await launch({ data, workspace, fauxScript: script, env: { KISO_DESKTOP_MODE: "full-access", KISO_DESKTOP_SANITIZER: sanitizer } });
out(`host ${host.origin} pid ${host.pid} sanitizer=${sanitizer}`);
const s = clientFor(host).session("s23");
const t0 = Date.now();
const wire = [];
const frames = [];
for await (const ev of s.runStream("change the greeting")) {
	const dt = String(Date.now() - t0).padStart(5);
	if (ev.kind === "comment") continue;
	if (ev.kind === "frame") {
		frames.push(ev);
		out(`${dt}ms FRAME ${ev.event} ${JSON.stringify(ev.data)}`);
	} else {
		const e = ev.event;
		wire.push(e);
		const { seq, type, ...rest } = e;
		out(`${dt}ms ${String(seq).padStart(3)} ${type} ${JSON.stringify(rest)}`.slice(0, 600));
	}
}
await s.state().then((st) => out(`state ${JSON.stringify(st)}`));
host.child.kill("SIGTERM");

const { check, verdict } = checker(out);
const of = (name) => frames.filter((f) => f.event === name).map((f) => f.data);
const edit = wire.find((e) => e.type === "tool_call_end" && e.name === "edit_file");
const write = wire.find((e) => e.type === "tool_call_end" && e.name === "write_file");
check(!wire.some((e) => e.type === "usage"), "usage is not a wire event");
check(wire.filter((e) => e.type === "thinking").length === 5, "thinking reaches the client (exposeThinking on)");
if (sanitizer === "desktop") {
	check(edit.input.edits[0].oldText.length >= 500 && edit.input.edits[0].newText.length >= 500, "edit_file oldText and newText arrive whole (570 chars each)");
	check(typeof write.input.content === "string" && write.input.content.length === 480, "write_file content arrives whole");
	check(of("at").length >= 8, `at frames beside the non-delta events (${of("at").length})`);
	const ats = of("at");
	check(ats.every((a, i) => i === 0 || a.ts >= ats[i - 1].ts) && ats.every((a) => wire.some((e) => e.seq === a.seq)), "at frames: nondecreasing times, each names a wire event");
	check(of("usage").length === 3, "one usage frame per usage event");
	const total = of("run_usage")[0];
	check(total?.fresh === 1900 && total?.cacheRead === 2600 && Math.abs(total.cacheRate - 57.78) < 0.01, `run_usage: fresh 1900, cache 2600, rate ${total?.cacheRate?.toFixed(2)}`);
	const outputs = of("tool_output");
	check(outputs.length === 5, "a tool_output frame per tool result");
	const sh = outputs.find((o) => o.lines === 15);
	check(sh?.head.length === 12 && sh.truncated === true, "a 15-line command output arrives as its first 12 lines, truncated");
} else {
	check(edit.input.edits[0].oldText.length <= 201, "default sanitizer cuts edit text at 200 characters");
	check(write.input.content === undefined, "default sanitizer drops write_file content");
}
verdict(sanitizer === "desktop" ? "stream (desktop sanitizer)" : "stream (default sanitizer)");
