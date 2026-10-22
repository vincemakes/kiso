// The stream, drawn: the scripted run of the approved mock (thinking that pages, a read, an edit that asks, a command that
// moves to the background, an answer in markdown) watched in the Electron window's DOM. A MutationObserver in the page samples
// what a person could have seen at every change. Screenshots go outside the repository.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchElectron, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("stream-ui");
const P = ["First I will read the README to see what the install section says.", "Then I will cut it down to three steps and keep the line about needing no key.", "Last I will run the tests and report."];
const THINK = `${P[0]} It is short.\n\n${P[1]} That is the plan.\n\n${P[2]}`;
const ANSWER = "## Done\n\nThe install section is now **three steps**, and `npm test` passes: 12 tests.\n\n- Install Node 22\n- Run `npm ci`\n- Run `npm start`\n\nThe line about needing no key is still there.";
const slow = (text, size, ms, type) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")).flatMap((chunk) => [{ type, text: chunk }, { type: "delay", ms }]);
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const OLD = "1. Pick a package manager\n2. Clone the repository\n3. Install Node\n4. Install the packages\n5. Run the app";
const stop = { type: "stop", reason: "tool_use" };
const workspace = scratch("ui-ws");
writeFileSync(join(workspace, "README.md"), `# kiso\n\n${OLD}\n\nNo key needed on the first run.\n`);
const app = await launchElectron({ data: scratch("ui-data"), workspace, env: { KISO_DESKTOP_MODE: "default", KISO_DESKTOP_MIN_FG_MS: "0", KISO_DESKTOP_SESSION: "ui" }, fauxScript: [
	{ events: [...slow(THINK, 14, 25, "thinking"), { type: "text_delta", text: "Reading the README first." }, call("c1", "read_file", { path: "README.md" }), use(1000, 80, 0), stop] },
	{ events: [call("c2", "edit_file", { path: "README.md", edits: [{ oldText: OLD, newText: "1. Install Node 22\n2. Run npm ci\n3. Run npm start" }] }), use(1300, 60, 1000), stop] },
	{ events: [call("c3", "shell", { command: "sleep 4; echo 12 tests passed", foregroundMs: 800 }), use(1400, 40, 1300), stop] },
	{ events: [...slow(ANSWER, 6, 20, "text_delta"), use(1500, 120, 1400), { type: "stop", reason: "end_turn" }] },
] });
await app.evaluate(`window.__snaps = []; new MutationObserver(() => {
	const q = (s) => document.querySelector(s);
	window.__snaps.push({ answer: q('[data-kind=answer]')?.textContent ?? null, folded: q('[data-kind=process]')?.dataset.folded ?? null, asks: document.querySelectorAll('[data-kind=ask]').length,
		live: !!q('.think.thinking'), line: q('.pv1 .on')?.textContent ?? null, footer: q('[data-kind=footer]') !== null, place: q('textarea')?.placeholder ?? null });
}).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true, attributes: true }); true`);
await app.evaluate(`window.__kiso.send("Shorten the install steps in README.md, then run the tests")`);
let approved = 0;
const shot = {};
for (let i = 0; i < 600 && !(await app.text("[data-kind=footer]")); i++) {
	if (!shot.think && (await app.count(".pv1 .on"))) (shot.think = true, await sleep(200), await app.shot("1-thinking"));
	if (await app.count("[data-act=allow]")) (await sleep(400), await app.shot(`2-approval-${approved}`), await app.click("[data-act=allow]"), (approved += 1), await sleep(250));
	if (!shot.bg && (await app.count(".bgtag"))) (shot.bg = true, await app.shot("3-background-step"));
	await sleep(40);
}
await sleep(1500);
await app.shot("4-folded-with-answer");
const snaps = JSON.parse(await app.evaluate("JSON.stringify(window.__snaps)"));
const lines = [...new Set(snaps.map((s) => s.line).filter((l) => l !== null))];
check(approved === 2, "two approvals were asked and answered through the cards");
check(JSON.stringify(lines) === JSON.stringify(P) && snaps.some((s) => s.live && s.line !== null), "the thinking line paged through the three paragraphs' first sentences, in order, never a half sentence, while the model was still thinking");
const streaming = snaps.filter((s) => s.answer !== null && !s.footer);
check(streaming.length > 5 && streaming.every((s) => s.folded === "false"), `the process stayed open through ${streaming.length} samples of the streaming answer`);
check(snaps.at(-1).folded === "true" && snaps.at(-1).footer && snaps.at(-1).asks === 0, "when the run ended the process folded, the footer appeared and no approval was left");
check(snaps.every((s) => s.answer === null || (!s.answer.includes("**") && (s.answer.match(/`/g) ?? []).length % 2 === 0 && !s.answer.endsWith("*"))) && new Set(snaps.map((s) => s.answer?.length)).size > 8, "the answer grew in small steps and never showed an unclosed ** or backtick");
check(snaps.filter((s) => s.asks > 0).every((s) => s.folded === "false"), "while an approval card was open the process was not folded");
check(snaps.some((s) => s.place === "Add a line, or press Esc to stop…") && snaps.at(-1).place === "Ask kiso to do something…", "the input box changes its placeholder while a run is live, and back");
await app.click(".ph");
await sleep(900);
await app.shot("5-process-open");
const text = (q) => app.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(q)})].map(d => d.className + ':' + d.textContent))`).then(JSON.parse);
const edit = await text(".step[data-tool=edit_file] .s-out div");
check((await text(".step .s-verb")).map((v) => v.split(":")[1]).join() === "Read,Edit,Run", "three steps: Read, Edit, Run");
check(edit.filter((l) => l.startsWith("d:")).length === 5 && edit.filter((l) => l.startsWith("a:")).length === 3, "the edit step shows its diff: 5 removed, 3 added");
check((await text(".step[data-tool=read_file] .s-out div"))[0] === ":# kiso", "the read step shows the first lines of the file");
check(await waitUntil(async () => /t1 · exited 0/.test((await app.text(".step[data-tool=shell] .s-req")) ?? ""), 8000) && (await app.count(".step[data-tool=shell] .bgtag")) === 1, "the command that moved to the background shows its tag, its task and its end");
check(/^Thought for \d+ s$/.test(await app.text(".think .lab")), "the thinking row ends as Thought for N s");
await app.click(".th-h");
await sleep(700);
await app.shot("6-thinking-open");
check((await app.text(".th-text")) === THINK && (await app.evaluate("document.querySelector('.think').classList.contains('open')")), "opening the thinking row shows its whole text");
check(/^\d+ s · .* in · .* out · \d+% cache$/.test(await app.text("[data-kind=footer]")), "the footer: duration, tokens in and out, cache rate");
await app.close();
verdict();
