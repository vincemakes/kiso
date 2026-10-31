// The stream model and the answer's markdown. A real host run (default tier, two approvals, a command that moves to the
// background) is fed to the reducer input by input, then the pure pieces: hold-back, parse, the edit diff, notices.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, checker, sleep, waitUntil } from "./lib.mjs";
import { initialState, reduce, split, folded, isInterrupted, isLive } from "../../dist/renderer/state/model.js";
import { holdBack, parse, render } from "../../dist/renderer/state/markdown.js";
import { editDiff } from "../../dist/renderer/state/diff.js";

const { check, verdict } = checker("model");
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const think = (text) => ({ type: "thinking", text });
const ANSWER = "## Done\n\nThe steps are now **three** and `npm test` passes.\n\n- Install Node\n- Run `npm ci`";
const workspace = scratch("model-ws");
writeFileSync(join(workspace, "README.md"), "Step one\nStep two\nStep three\nStep four\nStep five\n");
const host = await launch({ data: scratch("model-data"), workspace, env: { KISO_WEB_MIN_FG_MS: "0" }, fauxScript: [
	{ events: [think("First I will read the file. "), think("It is short.\n\n"), think("Then I will change the steps.\n\n"), think("And run the tests."), { type: "text_delta", text: "Reading first." }, call("c1", "read_file", { path: "README.md" }), use(1000, 50, 0), { type: "stop", reason: "tool_use" }] },
	{ events: [call("c2", "edit_file", { path: "README.md", edits: [{ oldText: "Step one\nStep two\nStep three\nStep four\nStep five", newText: "Step one\nStep two\nStep three" }] }), use(1200, 60, 1000), { type: "stop", reason: "tool_use" }] },
	{ events: [call("c3", "shell", { command: "sleep 3; echo tests-passed", foregroundMs: 500 }), use(1300, 40, 1100), { type: "stop", reason: "tool_use" }] },
	{ events: [...ANSWER.match(/.{1,7}/gs).map((text) => ({ type: "text_delta", text })), use(1500, 90, 1300), { type: "stop", reason: "end_turn" }] },
] });
const s = clientFor(host).session("model");
const inputs = [];
const ctl = new AbortController();
const reader = (async () => {
	for await (const ev of s.events({ signal: ctl.signal })) inputs.push(ev.kind === "event" ? { kind: "event", event: ev.event } : { kind: "frame", name: ev.event, data: ev.data });
})();
await s.run("shorten the install steps and run the tests");
const answered = new Set();
await waitUntil(async () => {
	for (const p of (await s.state()).pendingApprovals) if (!answered.has(p.decisionId)) (answered.add(p.decisionId), await sleep(150), await s.approve(p.decisionId, true));
	return inputs.some((x) => x.kind === "frame" && x.name === "tasks" && x.data.tasks.some((t) => t.label.startsWith("exited")));
}, 20_000, 50);
ctl.abort();
await reader;
host.child.kill("SIGTERM");

const state = initialState();
let firstLine = null; // the thinking text at the moment its first line appeared
const folds = inputs.map((x) => {
	reduce(state, x);
	const think = state.turns[0]?.items[0];
	if (firstLine === null && think?.kind === "thinking" && think.lines.length > 0) firstLine = { text: think.text, lines: [...think.lines] };
	return state.turns[0] && folded(state.turns[0], undefined);
});
const turn = state.turns[0];
const { process: proc, answer, openAsks } = split(turn);
const isTerminal = (x) => x.kind === "event" && x.event.type === "terminal";
const lastText = inputs.map((x) => x.kind === "event" && x.event.type === "text_delta").lastIndexOf(true);
check(state.turns.length === 1 && turn.phase === "ended" && turn.outcome === "completed", "one turn, ended: completed");
check(folds.indexOf(true) === inputs.findIndex(isTerminal) && folds.indexOf(true) > lastText, "the process folds at the terminal, after the last answer text, never while the answer streams");
check(proc.map((i) => i.kind).join() === "thinking,text,step,step,ask,step,ask" && answer?.text === ANSWER && openAsks.length === 0, `the process holds thinking, narration, three steps and two approvals; the answer is the trailing text: ${proc.map((i) => i.kind).join()}`);
check(JSON.stringify(turn.items[0].lines) === '["First I will read the file.","Then I will change the steps.","And run the tests."]' && turn.items[0].endedAt >= turn.items[0].startedAt, "the thinking line pages through each paragraph's first sentence, with a start and an end");
check(firstLine?.lines[0] === "First I will read the file." && !firstLine.text.includes("\n\n"), "the thinking line is shown before its paragraph has been written to the end");
const steps = turn.items.filter((i) => i.kind === "step");
check(steps.every((x) => x.status === "done" && x.endedAt >= x.startedAt), "every step is done and timed");
check(steps[0].output.head[0] === "Step one" && editDiff(steps[1].input).filter((l) => l.kind === "del").length === 2, "the read step has its first lines; the edit step has its diff");
check(steps[2].taskId === "t1" && state.tasks.find((t) => t.id === "t1")?.label === "exited 0", "the long command became task t1, and the task row ended exited 0");
check(turn.footer?.fresh === 1600 && turn.footer?.output === 240 && Math.abs(turn.footer.cacheRate - 68) < 0.5, `the footer: ${JSON.stringify(turn.footer)}`);
const again = initialState();
inputs.forEach((x) => reduce(again, x));
const mid = initialState();
inputs.slice(0, inputs.findIndex((x) => x.kind === "event" && x.event.type === "permission_requested") + 1).forEach((x) => reduce(mid, x));
check(JSON.stringify(again.turns) === JSON.stringify(state.turns), "the same inputs give the same turns");
check(split(mid.turns[0]).openAsks.length === 1 && mid.turns[0].items.some((i) => i.kind === "step" && i.status === "waiting"), "between request and decision the approval is open and its step waits");

// a runtime notice inside a live run is a quiet line; the interrupted-run state follows the host's snapshot
const n = initialState();
[{ type: "user_input", seq: 0, content: "go" }, { type: "user_input", seq: 1, content: '<kiso-task id="t1" status="exited" code="0" duration="8s"/>\nRuntime notice - not the user.', source: "system" }].forEach((event) => reduce(n, { kind: "event", event }));
check(n.turns.length === 1 && n.turns[0].items[0]?.kind === "notice" && n.turns[0].items[0].text === "Task t1 exited", "a system notice is a line in the run, not a new turn");
reduce(n, { kind: "snapshot", state: { sessionId: "x", running: false, highWater: 1, openRun: "r1", pendingApprovals: [], uncertain: [] } });
check(isInterrupted(n) && !isLive(n), "a running turn the host no longer runs is interrupted");
const v = initialState();
[{ type: "user_input", seq: 0, content: "go" }, { type: "text_delta", seq: 1, text: "part" }, { type: "tool_call_end", seq: 2, callId: "k", name: "shell", input: {} }, { type: "draft_voided", seq: 3, voidFromSeq: 0, reason: "x" }].forEach((event) => reduce(v, { kind: "event", event }));
check(v.turns[0].items.length === 0, "draft_voided removes the draft text and the call that never ran");

check(holdBack("a **bo") === "a " && holdBack("run `npm te") === "run " && holdBack("text *") === "text ", "an unclosed **, backtick or lone * is withheld with what follows it");
check(holdBack("a **b** and `c`") === "a **b** and `c`" && holdBack("```js\nconst a = **b") === "```js\nconst a = **b" && holdBack("```\nx ** y\n```\nthen `z") === "```\nx ** y\n```\nthen ", "closed markers are kept; an open fence withholds nothing; markers in a closed fence do not count");
const blocks = parse(ANSWER);
check(blocks.map((b) => b.t).join() === "h,p,ul" && blocks[1].inline.some((x) => x.t === "b") && blocks[1].inline.some((x) => x.t === "code"), "the answer parses to heading, paragraph, list with inline bold and code nodes");
check(JSON.stringify(render("<script>alert(1)</script> **x", true)).includes('"text":"<script>alert(1)</script>"') && parse("```sh\nnpm ci\nnpm test\n```")[0].text === "npm ci\nnpm test", "markup stays text; a fenced block keeps its lines");
verdict();
