// The stream model and the answer's markdown, on a real host run: the
// events and frames a client receives are fed to the reducer, and the turn
// it builds is checked against what the run did. Then the pure pieces on
// their own: the markdown hold-back, the parser, the edit diff.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launch, clientFor, scratch, transcript, checker, sleep } from "./lib.mjs";
import { initialState, reduce, split, folded } from "../../dist/renderer/state/model.js";
import { holdBack, parse, render } from "../../dist/renderer/state/markdown.js";
import { editDiff } from "../../dist/renderer/state/diff.js";

const out = transcript("model");
const { check, verdict } = checker(out);
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const think = (text) => ({ type: "thinking", text });
const ANSWER = "## Done\n\nThe install steps are now **three** steps and `npm test` passes.\n\n- Install Node\n- Run `npm ci`\n- Run `npm start`";
const script = [
	{ events: [think("First I will read the file. "), think("It is short.\n\n"), think("Then I will change the steps.\n\n"), think("And run the tests."), { type: "text_delta", text: "Reading the README first." }, call("c1", "read_file", { path: "README.md" }), use(1000, 50, 0), { type: "stop", reason: "tool_use" }] },
	{ events: [call("c2", "edit_file", { path: "README.md", edits: [{ oldText: "Step one\nStep two\nStep three\nStep four\nStep five", newText: "Step one\nStep two\nStep three" }] }), use(1200, 60, 1000), { type: "stop", reason: "tool_use" }] },
	{ events: [call("c3", "shell", { command: "sleep 3; echo tests-passed", foregroundMs: 500 }), use(1300, 40, 1100), { type: "stop", reason: "tool_use" }] },
	{ events: [...ANSWER.match(/.{1,7}/gs).map((text) => ({ type: "text_delta", text })), use(1500, 90, 1300), { type: "stop", reason: "end_turn" }] },
];
const data = scratch("model-data");
const workspace = scratch("model-ws");
writeFileSync(join(workspace, "README.md"), "Step one\nStep two\nStep three\nStep four\nStep five\n");
const host = await launch({ data, workspace, fauxScript: script, env: { KISO_DESKTOP_MIN_FG_MS: "0" } });
const s = clientFor(host).session("model");
const inputs = [];
const ctl = new AbortController();
const reader = (async () => {
	for await (const ev of s.events({ signal: ctl.signal })) {
		if (ev.kind === "event") inputs.push({ kind: "event", event: ev.event });
		else if (ev.kind === "frame") inputs.push({ kind: "frame", name: ev.event, data: ev.data });
	}
})();
await s.run("shorten the install steps and run the tests");
let approvals = 0;
const seenAsks = new Set();
for (let i = 0; i < 300; i++) {
	const st = await s.state();
	for (const p of st.pendingApprovals) {
		if (seenAsks.has(p.decisionId)) continue;
		seenAsks.add(p.decisionId);
		approvals += 1;
		await sleep(150); // the card is visible for a moment, as it would be to a person
		await s.approve(p.decisionId, true);
	}
	if (!st.running && st.pendingApprovals.length === 0 && inputs.some((x) => x.kind === "event" && x.event.type === "terminal")) break;
	await sleep(50);
}
// the task row is a frame polled once a second: wait for the 3 s command to end
for (let i = 0; i < 100 && !inputs.some((x) => x.kind === "frame" && x.name === "tasks" && x.data.tasks.some((t) => t.id === "t1" && t.label.startsWith("exited"))); i++) await sleep(100);
ctl.abort();
await reader;
host.child.kill("SIGTERM");
out(`${inputs.length} inputs (${inputs.filter((x) => x.kind === "event").length} events, ${inputs.filter((x) => x.kind === "frame").length} frames); ${approvals} approvals answered`);

// feed them one by one, watching the fold
const state = initialState();
const foldedAt = [];
inputs.forEach((x, i) => {
	reduce(state, x);
	const turn = state.turns.at(-1);
	if (turn !== undefined) foldedAt.push([i, x, folded(turn, undefined)]);
});
const turn = state.turns[0];
const { process: proc, answer, openAsks } = split(turn);
out(`turn: ${turn.items.map((i) => i.kind + (i.kind === "step" ? `:${i.name}:${i.status}` : "")).join(" ")}`);
check(state.turns.length === 1 && turn.user === "shorten the install steps and run the tests", "one turn, with the person's line");
check(turn.phase === "ended" && turn.outcome === "completed", "the turn ended: completed");
const firstFold = foldedAt.findIndex(([, , f]) => f);
const terminalAt = foldedAt.findIndex(([, x]) => x.kind === "event" && x.event.type === "terminal");
const lastTextAt = foldedAt.map(([, x]) => x.kind === "event" && x.event.type === "text_delta").lastIndexOf(true);
check(firstFold === terminalAt && firstFold > lastTextAt, `the process folds at the terminal (input ${firstFold}), after the last answer text (${lastTextAt}), never while the answer streams`);
check(proc.map((i) => i.kind).join(",") === "thinking,text,step,step,ask,step,ask", `the process holds thinking, narration, three steps and two approvals: ${proc.map((i) => i.kind).join(",")}`);
check(answer !== null && answer.text === ANSWER, "the answer is the trailing text, whole");
check(openAsks.length === 0, "no approval is left open");
const think1 = turn.items[0];
check(think1.lines.length === 3 && think1.lines[0] === "First I will read the file." && think1.lines[1] === "Then I will change the steps.", `the thinking line pages through the paragraphs' first sentences: ${JSON.stringify(think1.lines)}`);
check(think1.startedAt !== null && think1.endedAt !== null && think1.endedAt >= think1.startedAt, "the thinking block has a start and an end from the durable times");
const steps = turn.items.filter((i) => i.kind === "step");
check(steps.every((x) => x.status === "done" && x.startedAt !== null && x.endedAt !== null && x.endedAt >= x.startedAt), "every step is done and timed");
const read = steps.find((x) => x.name === "read_file");
check(read.output?.head[0] === "Step one" && read.output.lines >= 5, "the read step carries the first lines of its output");
const edit = steps.find((x) => x.name === "edit_file");
const diff = editDiff(edit.input);
check(diff.filter((l) => l.kind === "del").length === 2 && diff.filter((l) => l.kind === "add").length === 0, `the edit step's diff: ${diff.map((l) => (l.kind === "del" ? "-" : l.kind === "add" ? "+" : " ") + l.text).join(" | ")}`);
const shell = steps.find((x) => x.name === "shell");
check(shell.taskId === "t1" && state.tasks.some((t) => t.id === "t1"), "the long command became task t1 and the step knows it");
check(state.tasks.find((t) => t.id === "t1")?.label === "exited 0", `the task row ends in the state: ${state.tasks.find((t) => t.id === "t1")?.label}`);
// fresh: (1000-0)+(1200-1000)+(1300-1100)+(1500-1300) = 1600; cache 1000+1100+1300 = 3400 -> 68%
check(turn.footer?.fresh === 1600 && turn.footer?.output === 240 && Math.abs(turn.footer.cacheRate - 68) < 0.5, `the footer: ${JSON.stringify(turn.footer)}`);
// the same inputs give the same state
const again = initialState();
for (const x of inputs) reduce(again, x);
check(JSON.stringify(again.turns) === JSON.stringify(state.turns), "replaying the same inputs gives the same turns");
// a approval is open between its request and its decision
const mid = initialState();
const upto = inputs.findIndex((x) => x.kind === "event" && x.event.type === "permission_requested");
inputs.slice(0, upto + 1).forEach((x) => reduce(mid, x));
check(split(mid.turns[0]).openAsks.length === 1 && mid.turns[0].items.find((i) => i.kind === "step" && i.status === "waiting") !== undefined, "between request and decision the approval is open and its step waits");

out("--- markdown");
check(holdBack("a **bo") === "a ", "an unclosed ** and what follows it are withheld");
check(holdBack("run `npm te") === "run ", "an unclosed backtick and what follows it are withheld");
check(holdBack("a **b** and `c`") === "a **b** and `c`", "closed markers are kept");
check(holdBack("text *") === "text ", "a lone trailing * may start a **");
check(holdBack("```js\nconst a = **b") === "```js\nconst a = **b", "inside an open fence nothing is withheld");
check(holdBack("```\nx ** y\n```\nthen `z") === "```\nx ** y\n```\nthen ", "markers inside a closed fence do not count");
const blocks = parse(ANSWER);
check(blocks.map((b) => b.t).join(",") === "h,p,ul", `the answer parses to heading, paragraph, list: ${blocks.map((b) => b.t).join(",")}`);
check(blocks[1].inline.some((n) => n.t === "b") && blocks[1].inline.some((n) => n.t === "code"), "bold and code are inline nodes, not markup");
check(JSON.stringify(render("<script>alert(1)</script> **x", true)).includes('"text":"<script>alert(1)</script>"'), "markup in the answer stays text");
check(parse("```sh\nnpm ci\nnpm test\n```")[0].text === "npm ci\nnpm test", "a fenced block keeps its lines");
verdict("model");
