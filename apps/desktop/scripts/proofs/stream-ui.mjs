// The stream, drawn: a scripted run like the approved mock (thinking that
// pages, a read, an edit that asks, a command that moves to the background,
// an answer in markdown), watched in the Electron window's DOM through the
// debugging port. A MutationObserver in the page samples what a person
// could have seen at every change. Screenshots go outside the repository.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, transcript, checker, launchElectron, waitUntil, sleep } from "./lib.mjs";

const out = transcript("stream-ui");
const { check, verdict } = checker(out);
const P1 = "First I will read the README to see what the install section says.";
const P2 = "Then I will cut it down to three steps and keep the line about needing no key.";
const P3 = "Last I will run the tests and report.";
const THINK = `${P1} It is short.\n\n${P2} That is the plan.\n\n${P3}`;
const ANSWER = "## Done\n\nThe install section is now **three steps**, and `npm test` passes: 12 tests.\n\n- Install Node 22\n- Run `npm ci`\n- Run `npm start`\n\nThe line about needing no key is still there.";
const slow = (text, size, ms, type) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")).flatMap((chunk) => [{ type, text: chunk }, { type: "delay", ms }]);
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const OLD = "1. Pick a package manager\n2. Clone the repository\n3. Install Node\n4. Install the packages\n5. Run the app";
const NEW = "1. Install Node 22\n2. Run npm ci\n3. Run npm start";
const script = [
	{ events: [...slow(THINK, 14, 25, "thinking"), { type: "text_delta", text: "Reading the README first." }, call("c1", "read_file", { path: "README.md" }), use(1000, 80, 0), { type: "stop", reason: "tool_use" }] },
	{ events: [call("c2", "edit_file", { path: "README.md", edits: [{ oldText: OLD, newText: NEW }] }), use(1300, 60, 1000), { type: "stop", reason: "tool_use" }] },
	{ events: [call("c3", "shell", { command: "sleep 4; echo 12 tests passed", foregroundMs: 800 }), use(1400, 40, 1300), { type: "stop", reason: "tool_use" }] },
	{ events: [...slow(ANSWER, 6, 20, "text_delta"), use(1500, 120, 1400), { type: "stop", reason: "end_turn" }] },
];
const workspace = scratch("ui-ws");
writeFileSync(join(workspace, "README.md"), `# kiso\n\n${OLD}\n\nNo key needed on the first run.\n`);
mkdirSync(join(process.env.HOME, "kiso-worktrees", "desktop-s1-shots"), { recursive: true });
const app = await launchElectron({ data: scratch("ui-data"), workspace, fauxScript: script, env: { KISO_DESKTOP_MODE: "default", KISO_DESKTOP_MIN_FG_MS: "0", KISO_DESKTOP_SESSION: "ui" } });
const ev = (js) => app.evaluate(js);
// sample the page at every change
await ev(`window.__snaps = []; new MutationObserver(() => {
	const q = (s) => document.querySelector(s);
	window.__snaps.push({ t: Date.now(), answer: q('[data-kind=answer]')?.textContent ?? null, folded: q('[data-kind=process]')?.dataset.folded ?? null,
		asks: document.querySelectorAll('[data-kind=ask]').length, live: !!q('.think.thinking'), line: q('.pv1 .on')?.textContent ?? null, footer: q('[data-kind=footer]') !== null, place: q('textarea')?.placeholder ?? null });
}).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true, attributes: true }); true`);
await ev(`window.__kiso.send("Shorten the install steps in README.md, then run the tests")`);
let approved = 0;
let shotThinking = false;
let shotAsk = false;
let shotBg = false;
for (let i = 0; i < 600; i++) {
	if ((await ev(`!!document.querySelector('[data-kind=footer]')`)) === true) break;
	if (!shotThinking && (await ev(`!!document.querySelector('.pv1 .on')`))) {
		await sleep(200);
		await app.shot("1-thinking");
		shotThinking = true;
	}
	if ((await ev(`!!document.querySelector('[data-act=allow]')`)) === true) {
		if (!shotAsk) {
			await sleep(400);
			await app.shot(approved === 0 ? "2-approval-edit" : "3-approval-run");
			shotAsk = approved === 1;
		}
		await ev(`document.querySelector('[data-act=allow]').click()`);
		approved += 1;
		await sleep(250);
	}
	if (!shotBg && (await ev(`!!document.querySelector('.bgtag')`))) {
		await app.shot("4-background-step");
		shotBg = true;
	}
	await sleep(40);
}
check(approved === 2, `two approvals were asked and answered through the cards (${approved})`);
await sleep(1500);
await app.shot("5-folded-with-answer");
const snaps = JSON.parse(await ev(`JSON.stringify(window.__snaps)`));
out(`${snaps.length} page samples`);

// thinking pages through each paragraph's first sentence, never a half sentence
const lines = [...new Set(snaps.map((s) => s.line).filter((l) => l !== null))];
out(`lines the thinking row showed: ${JSON.stringify(lines)}`);
check(lines.length === 3 && lines[0] === P1 && lines[1] === P2 && lines[2] === P3, "the one line paged through the three paragraphs' first sentences, in order");
check(snaps.some((s) => s.live && s.line !== null), "the line was on screen while the model was still thinking");
// the process never folds while the answer streams
const streaming = snaps.filter((s) => s.answer !== null && !s.footer);
check(streaming.length > 5 && streaming.every((s) => s.folded === "false"), `the process stayed open through ${streaming.length} samples of the streaming answer`);
const last = snaps.at(-1);
check(last.folded === "true" && last.footer, "when the run ended the process folded and the footer appeared");
// held-back markers: the reader never saw a stray marker
check(snaps.every((s) => s.answer === null || (!s.answer.includes("**") && (s.answer.match(/`/g) ?? []).length % 2 === 0 && !s.answer.endsWith("*"))), "no sampled answer showed an unclosed ** or backtick");
check(new Set(snaps.map((s) => s.answer?.length)).size > 8, "the answer grew in many small steps");
// approvals
const askSamples = snaps.filter((s) => s.asks > 0);
check(askSamples.length > 0 && askSamples.every((s) => s.folded === "false"), "while an approval card was open the process was not folded");
check(last.asks === 0, "no approval card is left after the answers");
// steps
const verbs = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.step')].map(s => s.querySelector('.s-verb').textContent))`));
check(JSON.stringify(verbs) === JSON.stringify(["Read", "Edit", "Run"]), `three steps: ${verbs.join(", ")}`);
await ev(`document.querySelector('.ph').click()`);
await sleep(900);
await app.shot("6-process-open");
const editOut = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('.step[data-tool=edit_file] .s-out div')].map(d => d.className + ':' + d.textContent))`));
check(editOut.filter((l) => l.startsWith("d:")).length === 5 && editOut.filter((l) => l.startsWith("a:")).length === 3, `the edit step shows its diff: ${editOut.length} lines, 5 removed, 3 added`);
check((await ev(`document.querySelector('.step[data-tool=read_file] .s-out div')?.textContent`)) === "# kiso", "the read step shows the first lines of the file");
check(await waitUntil(async () => /t1 · exited 0/.test(await ev(`document.querySelector('.step[data-tool=shell] .s-req')?.textContent ?? ''`)), 8000), "the command that moved to the background shows its task, and its end");
check((await ev(`!!document.querySelector('.step[data-tool=shell] .bgtag')`)) === true, "the moved-to-background tag");
// thinking: ends as "Thought for", opens to the whole text
check(/^Thought for \d+ s$/.test(await ev(`document.querySelector('.think .lab').textContent`)), `the thinking row ends as: ${await ev(`document.querySelector('.think .lab').textContent`)}`);
await ev(`document.querySelector('.th-h').click()`);
await sleep(700);
await app.shot("7-thinking-open");
check((await ev(`document.querySelector('.think').classList.contains('open')`)) === true && (await ev(`document.querySelector('.th-text').textContent`)) === THINK, "opening the thinking row shows its whole text");
// composer
check(snaps.some((s) => s.place === "Add a line, or press Esc to stop…") && last.place === "Ask kiso to do something…", "the input box changes its placeholder while a run is live, and back");
check(/^\d+ s · .* in · .* out · \d+% cache$/.test(await ev(`document.querySelector('[data-kind=footer]').textContent`)), `the footer: ${await ev(`document.querySelector('[data-kind=footer]').textContent`)}`);
await app.close();
verdict("stream-ui");
