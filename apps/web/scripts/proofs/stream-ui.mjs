// The stream, drawn: the scripted run of the approved mock (thinking that pages, a read, an edit that asks, a command that
// moves to the background, an answer in markdown) watched in a browser tab's DOM. A MutationObserver in the page samples
// what a person could have seen at every change. Screenshots go outside the repository.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";
import { READING } from "../../dist/renderer/state/reading.js";

const { check, verdict } = checker("stream-ui");
const P = ["First I will read the README to see what the install section says.", "Then I will cut it down to three steps and keep the line about needing no key.", "Last I will run the tests and report."];
const THINK = `${P[0]} It is short.\n\n${P[1]} That is the plan.\n\n${P[2]}`;
const ANSWER = "## Done\n\nThe install section is now **three steps**, and `npm test` passes: 12 tests.\n\n- Install Node 22\n- Run `npm ci`\n- Run `npm start`\n\nThe line about needing no key is still there.\n\n| Step | Command | Note |\n|:--|:--|--:|\n" + ["Install", "Run `npm ci`", "Start"].map((c, i) => `| ${i + 1} | ${c} | ${"packages_runtime_src_a_long_name_that_cannot_wrap".repeat(5)} |`).join("\n");
const slow = (text, size, ms, type) => text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g")).flatMap((chunk) => [{ type, text: chunk }, { type: "delay", ms }]);
const call = (callId, name, input) => ({ type: "tool_call_end", callId, name, input });
const use = (i, o, c) => ({ type: "usage", inputTokens: i, outputTokens: o, cacheRead: c, cacheWrite: null, known: true });
const OLD = "1. Pick a package manager\n2. Clone the repository\n3. Install Node\n4. Install the packages\n5. Run the app";
const stop = { type: "stop", reason: "tool_use" };
const workspace = scratch("ui-ws");
writeFileSync(join(workspace, "README.md"), `# kiso\n\n${OLD}\n\nNo key needed on the first run.\n`);
const app = await launchApp({ data: scratch("ui-data"), workspace, env: { KISO_WEB_MODE: "default", KISO_WEB_MIN_FG_MS: "0", KISO_WEB_SESSION: "ui" }, fauxScript: [
	{ events: [...slow(THINK, 14, 25, "thinking"), { type: "text_delta", text: "Reading the `README.md` first." }, call("c1", "read_file", { path: "README.md" }), use(1000, 80, 0), stop] },
	{ events: [call("c2", "edit_file", { path: "README.md", edits: [{ oldText: OLD, newText: "1. Install Node 22\n2. Run npm ci\n3. Run npm start" }] }), use(1300, 60, 1000), stop] },
	{ events: [call("c3", "shell", { command: "sleep 4; echo 12 tests passed", foregroundMs: 800 }), use(1400, 40, 1300), stop] },
	// the answer: small deltas, then the rest in one burst of hundreds of characters
	{ events: [...slow(ANSWER.slice(0, 90), 6, 20, "text_delta"), { type: "text_delta", text: ANSWER.slice(90) }, use(1500, 120, 1400), { type: "stop", reason: "end_turn" }] },
	{ events: [...slow("Nothing to run for this, the answer is in what I read.", 9, 60, "thinking"), { type: "text_delta", text: "Yes." }, { type: "stop", reason: "end_turn" }] },
	{ events: [call("c4", "read_file", { path: join(workspace, "missing/notes.txt") }), stop] },
	{ events: [{ type: "text_delta", text: "Not there." }, { type: "stop", reason: "end_turn" }] },
] });
// every frame: how much answer text is drawn, how many live indicators, and whether the process header is covered by anything
await app.evaluate(`window.__frames = []; (function f() {
	const ph = document.querySelector('.ph'), r = ph?.getBoundingClientRect(), at = r && r.height > 0 ? document.elementFromPoint(r.left + 40, r.top + r.height / 2) : null;
	window.__frames.push({ n: [...document.querySelectorAll('[data-kind=answer] > :not(.tbl)')].reduce((sum, e) => sum + e.textContent.length, 0), lives: document.querySelectorAll('[data-kind=live]').length, carets: [...document.querySelectorAll('.caret *')].filter((e) => getComputedStyle(e, '::after').animationName === 'bl').length, early: !!document.querySelector('[data-kind=footer]') && [...document.querySelectorAll('[data-kind=answer]')].some((a) => a.dataset.settled !== 'true'), live: !!window.__kiso?.state.turns.at(-1)?.phase.startsWith('run'), covered: at !== null && !ph.contains(at) });
	requestAnimationFrame(f);
})(); true`);
const sc = (js) => app.evaluate(`(() => { const el = document.querySelector('.scroll'); ${js} })()`);
await app.evaluate(`window.__snaps = []; new MutationObserver(() => {
	const q = (s) => document.querySelector(s);
	window.__snaps.push({ answer: q('[data-kind=answer]')?.textContent ?? null, folded: q('[data-kind=process]')?.dataset.folded ?? null, asks: document.querySelectorAll('[data-kind=ask]').length,
		live: !!q('.think.thinking'), delim: [...document.querySelectorAll('[data-kind=answer] p')].some((p) => p.textContent.includes('|:--')), line: q('.pv1 .on')?.textContent ?? null, footer: q('[data-kind=footer]') !== null, place: q('textarea')?.placeholder ?? null });
}).observe(document.getElementById('root'), { subtree: true, childList: true, characterData: true, attributes: true }); true`);
await app.evaluate(`window.__kiso.send("Shorten the install steps in README.md, then run the tests")`);
let approved = 0;
const shot = {};
for (let i = 0; i < 600 && !(await app.text("[data-kind=footer]")); i++) {
	if (!shot.think && (await app.count(".pv1 .on"))) (shot.think = true, await sleep(200), await app.shot("1-thinking"));
	if (await app.count("[data-act=allow]")) (await sleep(400), await app.shot(`2-approval-${approved}`), await app.click("[data-act=allow]"), (approved += 1), await sleep(250));
	if (!shot.bg && (await app.count(".bgtag"))) (shot.bg = true, await app.shot("3-background-step"));
	// the person scrolls up to the answer's first lines while it still streams: from here the view must not move for them
	if (!shot.up && ((await app.text("[data-kind=answer]")) ?? "").length > 40) (shot.up = await sc(`el.scrollTop = el.scrollHeight - el.clientHeight - 250; el.dispatchEvent(new Event('scroll')); window.__read = [...el.querySelectorAll('${READING}')].find((e) => e.getBoundingClientRect().top >= el.getBoundingClientRect().top); return { top: window.__read.getBoundingClientRect().top, room: el.scrollHeight - el.clientHeight, what: window.__read.className || window.__read.tagName }`)), await sleep(300), await app.shot("5-scrolled-up-latest-pill");
	await sleep(40);
}
await sleep(1500);
const held = await sc("return { top: window.__read.getBoundingClientRect().top, pill: document.querySelectorAll('[data-act=latest]').length }");
check(shot.up.room > 300 && Math.abs(held.top - shot.up.top) <= 2 && held.pill === 1 && (await app.evaluate("document.querySelector('[data-kind=process]').dataset.folded")) === "true", `scrolled up while it streamed: the block they were reading (${shot.up.what}) stayed where it was through the rest of the stream and the fold at the end (${shot.up.top.toFixed(0)} -> ${held.top.toFixed(0)} px), and a Latest pill shows`);
await app.click("[data-act=latest]");
check(await waitUntil(() => sc("return el.scrollHeight - el.scrollTop - el.clientHeight < 2 && document.querySelectorAll('[data-act=latest]').length === 0")), "the pill takes the view to the latest and goes");
await app.shot("4-folded-with-answer");
const snaps = JSON.parse(await app.evaluate("JSON.stringify(window.__snaps)"));
const lines = [...new Set(snaps.map((s) => s.line).filter((l) => l !== null))];
check(approved === 2, "two approvals were asked and answered through the cards");
check(JSON.stringify(lines) === JSON.stringify(P) && snaps.some((s) => s.live && s.line !== null), "the thinking line paged through the three paragraphs' first sentences, in order, never a half sentence, while the model was still thinking");
const streaming = snaps.filter((s) => s.answer !== null && s.place === "Add a line, or press Esc to stop…");
check(streaming.length > 5 && streaming.every((s) => s.folded === "false"), `the process stayed open through ${streaming.length} samples of the streaming answer`);
check(snaps.at(-1).folded === "true" && snaps.at(-1).footer && snaps.at(-1).asks === 0, "when the run ended the process folded, the footer appeared and no approval was left");
check(snaps.every((s) => s.answer === null || (!s.answer.includes("**") && (s.answer.match(/`/g) ?? []).length % 2 === 0 && !s.answer.endsWith("*"))) && new Set(snaps.map((s) => s.answer?.length)).size > 8, "the answer grew in small steps and never showed an unclosed ** or backtick");
check(snaps.filter((s) => s.asks > 0).every((s) => s.folded === "false"), "while an approval card was open the process was not folded");
// the wide table: it scrolls inside its own box, and nothing between it and the page scrolls sideways
const wide = await app.evaluate(`(() => { const t = document.querySelector('[data-kind=answer] [data-kind=table]'); const up = []; for (let e = t?.parentElement; e; e = e.parentElement) up.push(e.scrollWidth - e.clientWidth); return JSON.stringify({ rows: t?.querySelectorAll('tbody tr').length, inner: t ? t.scrollWidth - t.clientWidth : -1, up: Math.max(...up), code: t?.querySelectorAll('td code').length, right: t ? getComputedStyle(t.querySelector('th:last-child')).textAlign : null }); })()`).then(JSON.parse);
check(wide.rows === 3 && wide.code === 1 && wide.right === "right" && wide.inner > 0 && wide.up <= 0 && !snaps.some((s) => s.delim), `a wide table is drawn (3 rows, code in a cell, right-aligned column), scrolls inside its own box (${wide.inner} px) and the page never scrolls sideways (${wide.up} px); its delimiter row never showed as text`);
check(snaps.some((s) => s.place === "Add a line, or press Esc to stop…") && snaps.at(-1).place === "Ask kiso to do something…", "the input box changes its placeholder while a run is live, and back");
await app.click(".ph");
await sleep(900);
await app.shot("5-process-open");
const text = (q) => app.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(q)})].map(d => d.className + ':' + d.textContent))`).then(JSON.parse);
const edit = await text(".step[data-tool=edit_file] .s-lines > div");
check((await text(".step .s-verb")).map((v) => v.split(":")[1]).join() === "Read,Edit,Run", "three steps: Read, Edit, Run");
check(edit.filter((l) => l.startsWith("d:")).length === 5 && edit.filter((l) => l.startsWith("a:")).length === 3, "the edit step shows its diff: 5 removed, 3 added");
check((await text(".step[data-tool=read_file] .s-lines > div"))[0] === ":# kiso", "the read step shows the first lines of the file");
check(await waitUntil(async () => /t1 · exited 0/.test((await app.text(".step[data-tool=shell] .s-req")) ?? ""), 8000) && (await app.count(".step[data-tool=shell] .bgtag")) === 1, "the command that moved to the background shows its tag, its task and its end");
check(/^Thought for \d+ s$/.test(await app.text(".think .lab")), "the thinking row ends as Thought for N s");
await app.click(".th-h");
await sleep(700);
await app.shot("6-thinking-open");
check((await app.text(".th-text")) === THINK && (await app.evaluate("document.querySelector('.think').classList.contains('open')")), "opening the thinking row shows its whole text");
check(/^\d+ s · .* in · .* out · \d+% cache$/.test(await app.text("[data-kind=footer]")), "the footer: duration, tokens in and out, cache rate");
const frames = JSON.parse(await app.evaluate("JSON.stringify(window.__frames)"));
const jumps = frames.slice(1).map((f, i) => f.n - frames[i].n);
// (a table row is drawn whole once its closing pipe has arrived: rows are held back, not paced, so the pace is measured on the prose)
check(Math.max(...jumps) <= 30 && frames.at(-1).n === (await app.evaluate("[...document.querySelectorAll('[data-kind=answer] > :not(.tbl)')].reduce((s, e) => s + e.textContent.length, 0)")), `the answer's text, a burst of ${ANSWER.length - 90} characters included, appeared at most ${Math.max(...jumps)} characters a frame (cap 30), over ${jumps.filter((j) => j > 0).length} frames`);
check(frames.every((f) => f.lives <= 1) && frames.some((f) => f.live && f.lives === 1), "one live indicator at a time, never two");
check(frames.every((f) => f.carets <= 1) && frames.some((f) => f.carets === 1) && !frames.some((f) => f.early), "one caret at a time while text streams, and no footer before its answer is drawn to the end");
check(!frames.some((f) => f.covered), `nothing was ever drawn over the process header, in ${frames.length} frames (opening and folding included)`);
check((await app.evaluate("document.querySelector('.say code')?.textContent")) === "README.md" && !(await app.text(".say")).includes("`"), "narration gets inline markdown: code, no backticks");
const chev = (q) => app.evaluate(`(() => { const b = document.querySelector('${q}'), c = b.querySelector('.chev'); return [b.getAttribute('aria-expanded'), getComputedStyle(c).transform, !!(c.compareDocumentPosition(b.querySelector('.lab')) & 4)].join(); })()`);
const turned = "true,matrix(0, 1, -1, 0, 0, 0),true";
check((await chev(".th-h")) === turned && (await chev(".ph")) === turned, "open rows: the chevron is left of the label, turned down, aria-expanded true (process and thinking)");
await app.click(".th-h");
await app.click(".ph");
await sleep(500);
check((await chev(".th-h")) === "false,none,true" && (await chev(".ph")) === "false,none,true", "folded rows: the chevron points right, aria-expanded false");
// a second run with no tool steps, the sidebar open: its label has no step count, and its row stops spinning within a second of the end
await app.click("[data-act=sidebar]");
await app.evaluate(`window.__kiso.send("is that all?")`);
const row = () => app.evaluate("document.querySelector('.item[data-work=ui]')?.dataset.state ?? null");
check(await waitUntil(async () => (await row()) === "running", 10_000), "the sidebar row spins while the run works");
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 2, 20_000);
const ended = Date.now();
check((await waitUntil(async () => (await row()) === "idle", 1000, 50)) && Date.now() - ended <= 1000, `the row stops spinning ${Date.now() - ended} ms after the run's end (at most 1,000)`);
check(/^Worked for \d+ s$/.test(await app.evaluate("[...document.querySelectorAll('.ph .lab')].at(-1).textContent")), "a run with no tool steps says Worked for N s, without '· 0 steps'");
const bottom = await sc("return el.scrollHeight - el.scrollTop - el.clientHeight");
check(bottom < 2, `a run the person followed at the bottom ends at the bottom, fold included (${bottom} px above it)`);
await app.shot("6-zero-steps-sidebar-idle");
// a step that fails on a path in the Work's folder: its message once, in red, with the folder's paths relative and its root by name, here and in the rail
await app.evaluate(`window.__kiso.send("read the notes")`);
await waitUntil(async () => (await app.count("[data-kind=footer]")) === 3, 20_000);
const failed = await app.evaluate("JSON.stringify({ out: document.querySelectorAll('.step.failed .s-out').length, err: document.querySelector('.step.failed .s-err')?.textContent, obj: document.querySelector('.step.failed .s-obj')?.textContent, rail: [...document.querySelectorAll('[data-field=step] b')].map((b) => b.textContent) })").then(JSON.parse);
const name = workspace.split("/").pop();
check(failed.out === 0 && failed.err.includes("missing/notes.txt") && !failed.err.includes("/folders/") && failed.obj === "missing/notes.txt" && failed.rail.includes("Read missing/notes.txt") && (!failed.err.includes("root") || failed.err.includes(name)), `a failed step shows its message once, in red, without the folder's absolute path, here and in the rail: ${failed.err}`);
await app.close();
verdict();
