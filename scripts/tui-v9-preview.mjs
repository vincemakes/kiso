#!/usr/bin/env node
/**
 * kiso TUI v9 — THE TURN: the state model, as frames you can look at.
 *
 * The round this previews is not a visual one. design.md §8 says so in
 * as many words — "folding at every text boundary changes what commits
 * and when, which is the machinery every scrollback gate watches… must
 * not ride in a visual round" — so this page exists to settle the SHAPE
 * before any commit semantics move. Look at the screens; the code comes
 * after the ruling.
 *
 * The question it answers, which four rounds of patching did not: what
 * is on screen at every moment from the first byte of a turn to the
 * settle, and what moves.
 *
 * The answer, in one sentence: a turn is chip → (stretch → prose)* →
 * recap, where a STRETCH is the run of thinking and tool calls between
 * two prose blocks; while it runs it is ONE line that grows plus a
 * bounded act window; when it closes it commits as that same line,
 * frozen, with its key. The line you watch IS the line you keep.
 *
 * ONE
 * definition of every frame, two renderers: ANSI (your terminal, the
 * real medium) and HTML (a review page you can look at). They cannot
 * drift.
 *
 *   node scripts/tui-v9-preview.mjs                    # colored, your width
 *   node scripts/tui-v9-preview.mjs --plain            # zero SGR — the pipe contract
 *   node scripts/tui-v9-preview.mjs --width 64         # the narrow check
 *   node scripts/tui-v9-preview.mjs --html > out.html  # the review page
 *
 * The rule the preview exists to prove: every frame reads at full
 * strength with the palette OFF. Color is emphasis, never information.
 *
 * The tracked tree stays CJK-free (the ruling) — the ONE CJK frame
 * (the cursor contract) builds its glyphs from unicode escapes.
 */

// `… | head` closes the pipe early — a normal way to read this, not a crash.
process.stdout.on("error", (e) => {
	if (e.code === "EPIPE") process.exit(0);
	throw e;
});

const argv = process.argv.slice(2);
const HTML = argv.includes("--html");
const PLAIN = !HTML && (argv.includes("--plain") || process.env.NO_COLOR !== undefined);
const wIdx = argv.indexOf("--width");
const W = HTML ? 88 : Math.max(48, Math.min(120, wIdx >= 0 ? Number(argv[wIdx + 1]) : (process.stdout.columns || 88)));

// ─── the palette: five roles. Wrapper functions, so one frame
// definition renders to ANSI or to HTML with no branching downstream.
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = (t) => esc(t).replace(/`([^`]*)`/g, "<code>$1</code>"); // the caption backticks
const ANSI = { b: "1", d: "2", r: "31", g: "32", k: "38;5;110" };
const wrap = (role) => (t) => (HTML ? `<i class=${role}>${esc(t)}</i>` : PLAIN ? t : `\x1b[${ANSI[role]}m${t}\x1b[0m`);
const b = wrap("b"); // bold — identity and structure
const d = wrap("d"); // dim — metadata, hints, anything you can ignore
const r = wrap("r"); // red — failure, and nothing else
const g = wrap("g"); // green — diff additions, and nothing else
const k = wrap("k"); // code — inline backtick spans in kiso's prose
const p = (t) => (HTML ? esc(t) : t); // plain — the default weight
// REVERSE VIDEO (SGR 7). The only attribute that inverts using the
// TERMINAL'S OWN two colours, so it needs no theme detection. Closed
// with SGR 27, not SGR 0, so it composes with a surrounding span.
const rv = (t) => (HTML ? `<i class=rv>${esc(t)}</i>` : PLAIN ? t : `\x1b[7m${t}\x1b[27m`);

// ─── cell width — the preview obeys the invariant it describes. The
// CJK frame makes the cell math visible, so the width functions here
// are CELL-aware (the v7 preview's char-length width would undercount
// a CJK row and overrun W — exactly the bug class the cursor contract
// fixes). The real authority is width.ts in the package; this is the
// preview's local stand-in (the classic wide ranges).
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const cellW = (ch) => (WIDE.test(ch) ? 2 : 1);
const vw = (s) => {
	let w = 0;
	for (const ch of s.replace(/\x1b\[[0-9;]*m/g, "").replace(/<[^>]+>/g, "").replace(/&lt;|&gt;|&amp;/g, "x")) w += cellW(ch);
	return w;
};
const padR = (s, n) => s + " ".repeat(Math.max(0, n - vw(s)));
const padL = (s, n) => " ".repeat(Math.max(0, n - vw(s))) + s;
const cut = (s, n) => (vw(s) <= n ? s : s.slice(0, Math.max(0, n - 1)) + "…");

const caretOn = HTML ? '<i class=car> </i>' : PLAIN ? "_" : "\x1b[7m \x1b[27m";
/** Insert the caret at a DISPLAY column inside a row (CJK-safe). */
function insertCaret(row, col) {
	let out = "";
	let w = 0;
	let placed = false;
	for (let i = 0; i < row.length; ) {
		if (row[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*m/.exec(row.slice(i));
			if (m !== null) {
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		if (!placed && w >= col) {
			out += caretOn;
			w += 1;
			placed = true;
		}
		const cw = cellW(row[i]);
		out += row[i];
		w += cw;
		i += 1;
	}
	if (!placed) out += caretOn;
	return out;
}

// ─── the glyphs — the left edge alone distinguishes the states
const G = {
	fold: "\u2726", // ✦ the SETTLED stretch — still, past tense
	act: "\u2736", // ✶ the twinkle mid-cycle — the stretch is still working
	think: "\u2727", // ✧ the twinkle's first frame (the live thinking mark)
	run: "\u25cf", // ● the breathing mark of a running call
	queued: "\u25e6", // ◦ a call not started
	pause: "\u23f8", // ⏸ you have to do something
	dots: "\u22ef", // ⋯ the reasoning gutter
	child: "\u2514", // └
	bar: "\u2502", // │
	arrow: "\u2192", // → the answer join
	cursor: "\u2192", // → the selection cursor (with the bar)
};

const you = (t) => `${rv(cut(` ${t} `, W))}`; // the user chip — the SGR-7 chip alone, flush left (the W16 ruling)
const bodyRow = (t) => `  ${d(G.bar)} ${d(cut(t, W - 4))}`; // a bounded block's body row
const bodyEnd = (t) => `  ${d(G.child)} ${d(cut(t, W - 4))}`; // the block's last row — what was cut, where the rest is

/** The panel block — the bounded block that replaces the running
 *  tool's live window while an approval is pending. ONE definition,
 *  every panel frame calls it (the rule line, the title, the
 *  always-verbose args, the numbered options, the affordance line). */
function panelBlock(rule, title, args, sel) {
	const opt = (n, t, s) => (s ? ` ${b(`${n} ${t}`)}` : ` ${p(`${n} ${t}`)}`);
	return [
		`  ${d(G.bar)} ${rule}`,
		`  ${d(G.bar)} ${b(title)}`,
		`  ${d(G.bar)} ${d(cut("─ the full args — never truncated ─", W - 4))}`,
		...args.map((a) => `  ${d(G.bar)} ${a}`),
		`  ${d(G.bar)} ${opt(1, "Yes", sel === 1)}  ${opt(2, `Yes, don't ask again for ${cut(rule.split(" ")[0], 24)}`, sel === 2)}  ${opt(3, "No", sel === 3)}`,
		`  ${d(G.bar)} ${d(sel ? "enter sends · esc backs out" : "tab amend · esc cancel")}`,
		`  ${d(G.child)} `,
	];
}
const panelRule = (name, speaker, hint) => `${p(name)} ${d("needs approval — asked by")} ${b(speaker)}${hint ? `${d(" ·")} ${k(hint)}` : ""}`;

/** The chrome — CHROME_ROWS = 4, untouched: the box top, the input
 *  row, the box bottom, the status row. The input row hosts the
 *  panel's interaction (the lead + the caret). */
function chrome(lead, line, statusL, statusR, caret = true) {
	// R2/R3 (the owner's rulings, shipped): TWO SOLID RAILS, no box and
	// no corners; the composer has no lead arrow and the caret sits at
	// column one. The preview draws the product, not the prototype it
	// replaced — a page that shows a surface nobody ships is a page that
	// reviews a hallucination.
	const body = padR(`${lead}${line}${caret ? caretOn : ""}`, W);
	return [d("\u2500".repeat(W)), body, d("\u2500".repeat(W)), status(statusL, statusR)];
}
const status = (left, right) => {
	// the #16g rule: the right hint is CUT FIRST, then dropped, before
	// the status itself ever truncates.
	const l = cut(left, W);
	const room = W - vw(l) - 1;
	const rgt = room >= 8 ? cut(right, room) : "";
	return `${l}${d(" ".repeat(Math.max(1, W - vw(l) - vw(rgt))) + rgt)}`;
};
const idle = (right) => chrome("", "", d("ready"), d(right));

/** The preview obeys the invariant it describes — the local stand-in
 *  for the compositor's #checked: walk the row, copy SGR verbatim at
 *  zero width, cut once the visible width would exceed W (CELL-aware),
 *  close any span left open. */
function checked(line, W) {
	let out = "";
	let w = 0;
	let open = false;
	for (let i = 0; i < line.length; ) {
		if (line[i] === "\x1b") {
			const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
			if (m !== null) {
				open = m[0] !== "\x1b[0m";
				out += m[0];
				i += m[0].length;
				continue;
			}
		}
		const cw = cellW(line[i]);
		if (w + cw > W) return out + (open ? "\x1b[0m" : "");
		out += line[i];
		w += cw;
		i += 1;
	}
	return out;
}

// ─── the frames ════════════════════════════════════════════════════
const FRAMES = [];
const frame = (title, note, rows) => FRAMES.push({ title, note, rows });

// ─── the shared builders — ONE definition per element, every frame
//     calls them, so a frame cannot say something the model does not.

/** The stretch line. `phase` decides the mark and the tense; the terms
 *  are the segment's, in the fold's canonical order; the trouble clause
 *  rides the tail in the failure colour, on WORDS (law 1.3: strip the
 *  escapes and the fact survives); the key gives way never (R3g). */
/**
 * ONE TERM TABLE, TWO TENSES — [past, progressive, singular, plural].
 *
 * The bug this closes, found in review: the live rows were written by
 * hand and drifted from the settled vocabulary — `searching 1 pattern`
 * live against `ran 1 search` settled (the NOUN swapped at the settle),
 * and `running 4 shells`, which is verbatim the R3g defect the last
 * round removed. That falsifies this page's own central sentence, that
 * the settle changes the tense and the key and nothing else. One table
 * is the only way that sentence can stay true.
 */
const TERM = {
	read_file: ["read", "reading", "file", "files"],
	edit_file: ["edited", "editing", "file", "files"],
	write_file: ["wrote", "writing", "file", "files"],
	list_dir: ["listed", "listing", "directory", "directories"],
	search_text: ["ran", "running", "search", "searches"],
	shell: ["ran", "running", "shell command", "shell commands"],
};
const term = (name, n, live) => {
	const t = TERM[name];
	if (t === undefined) return `${n} \u00d7 ${name}`;
	return `${live ? t[1] : t[0]} ${n} ${n === 1 ? t[2] : t[3]}`;
};
/** R3i (review §2.1): a stretch with exactly ONE call names its TARGET
 *  instead of its count. `✦ thought 2s · read 1 file` replaces two rows
 *  — the thinking and the call — with a row that says less than either,
 *  and "thinking + one call" is the commonest shape a narrating model
 *  makes. This is the answer to the defect R3d killed R3b's per-segment
 *  folds over; the ≥2-cells rule alone does NOT answer it. */
const termOne = (name, target, live) => `${TERM[name] ? TERM[name][live ? 1 : 0] : name} ${target}`;

const COMPACT = [
	["directories", "dirs"],
	["directory", "dir"],
	["shell commands", "commands"],
	["shell command", "command"],
];
/**
 * THE STRETCH LINE, in three tenses.
 *
 * The correction that produced this version: an earlier draft painted
 * the SETTLED form — the ✦ and the past tense — while the work was
 * still running, so a finished-looking summary sat on top of three
 * live tool rows. That shape exists in no design. The mark and the
 * tense are the phase:
 *
 *   thinking  ✧ thinking 4s                       moving, present
 *   acting    ✶ reading 6 files · running 3 shells…  moving, present
 *   settled   ✦ thought 2s · read 6 files · ctrl+r   still,  past
 *
 * The line you watch is still the line you keep — it changes tense at
 * the close, and nothing else. What it must never do is claim, while
 * the work is in flight, to be the record of work that finished.
 */
const stretchLine = (phase, terms, trouble, keyed, chip) => {
	const mark = phase === "settled" ? b(G.fold) : d(phase === "thinking" ? G.think : G.act);
	const key = keyed ? " \u00b7 ctrl+r" : "";
	const bad = trouble === null || trouble === undefined ? "" : ` \u00b7 ${trouble}`;
	// THE LADDER, in the one order the design pins, and the order the
	// product must implement: the human's WORDS give way first (they are
	// on screen above, in the chip band), then the nouns compact
	// cheapest-first, then the counts cut, then the trouble clause cuts,
	// and the KEY gives way never — a fold with no key is work with no
	// way back to it.
	//
	// Review found the previous version unimplementable as written ("the
	// clause never gives way"): at W=64 a long clause overflowed after
	// the counts had already cut to a bare "…", so invariant ① would
	// throw in the product. Everything gives way except the key.
	let meta = terms.join(" \u00b7 ");
	let clause = bad;
	let words = chip === undefined ? "" : ` ${chip} `;
	const width = () => 2 + (words === "" ? 0 : vw(words) + 3) + vw(meta) + vw(clause) + vw(key);
	if (words !== "" && width() > W) {
		const room = W - (width() - vw(words)) - 1;
		words = room >= 4 ? `${cut(words, room + 1).replace(/…$/, "")}…` : "";
	}
	if (width() > W) {
		for (const [long, short] of COMPACT) {
			meta = meta.replaceAll(long, short);
			if (width() <= W) break;
		}
	}
	if (width() > W) {
		const room = W - (width() - vw(meta)) - 1;
		meta = room >= 2 ? `${cut(meta, room + 1).replace(/…$/, "")}…` : "\u2026";
	}
	if (width() > W && clause !== "") {
		const room = W - (width() - vw(clause)) - 1;
		clause = room >= 4 ? `${cut(clause, room + 1).replace(/…$/, "")}…` : "";
	}
	const painted = meta
		.split(" \u00b7 ")
		.map((t) => p(t))
		.join(d(" \u00b7 "));
	const lead = words === "" ? "" : `${rv(words)}${d(" \u00b7 ")}`;
	return `${mark} ${lead}${painted}${clause !== "" ? r(clause) : ""}${keyed ? d(key) : ""}`;
};

/** The act window's head — the call running right now. */
const actHead = (verb, target, secs) => `${b(G.run)} ${p(padR(verb, 5))} ${p(target)}${d(` · ${secs}`)}`;
/** The act window's body rows and its last row. */
const winRow = (t) => `${d(G.bar)} ${d(cut(t, W - 2))}`;
const winEnd = (t) => `${d(G.child)} ${d(cut(t, W - 2))}`;
const thinkRow = (t) => `${d(G.dots)} ${d(cut(t, W - 2))}`;
/** A settled call's own row — verb · target · outcome (§7.4). */
const callRow = (verb, target, outcome, tail) =>
	cut(`  ${p(padR(verb, 5))} ${p(target)} ${p(`(${outcome})`)}${tail ? d(` · ${tail}`) : ""}`, W);
const failRow = (verb, target, outcome) => `  ${p(padR(verb, 5))} ${r(target)} ${r(`(${outcome})`)}`;
const prose = (t) => p(cut(t, W));
const recap = (t) => `${b(G.fold)} ${d(cut(t, W - 2))}`;
const rule = () => d("─".repeat(W));

// the CJK line is built from escapes — the tracked tree stays CJK-free
const ASK_Q = "which deploy target should the release default to?";

// ═══ I · THE STREAMING HALF — what is on screen while it works ═════

frame(
	"01 · idle",
	"The baseline. Four chrome rows (rail · composer · rail · status) and nothing else. Every frame below sits on this.",
	[...idle("/ commands · ↑ history")],
);

frame(
	"02 · the message lands",
	"The chip band commits on the frame it is pushed and is never held. Whether it is never FOLDED is not settled here: A9 (an owner ruling) puts the words on the fold line when the turn ends with no prose — see frame 12c, which is where that shape is decided.",
	[you("fix the flaky test in editor.test.ts — it only fails on the pty runner"), ...chrome("", "", d(`${G.think} working 1s`), d("esc stop · alt+⏎ redirect"), false)],
);

frame(
	"03 · thinking",
	"The stretch is BORN as one line plus a four-row window. The twinkle walks the gutter, the seconds tick in place, the newest reasoning fills the window downward. What must not move: the gutter cell and the word `thinking` — only the digits and the window text change.",
	[
		you("fix the flaky test in editor.test.ts — it only fails on the pty runner"),
		stretchLine("thinking", ["thinking 4s"], null, false),
		thinkRow("editor.test.ts polls a timer that races the frame scheduler; the"),
		thinkRow("pty suite stubs time, so the flake is the 16ms coalesce window —"),
		thinkRow("reproduce it first, then pin the scheduler seam"),
		thinkRow(""),
		...chrome("", "", d(`${G.think} working 4s`), d("esc stop · alt+⏎ redirect"), false),
	],
);

frame(
	"04 · acting — present tense, still moving",
	"Thinking stopped and the work started, so the line switches to what it is DOING: present tense, the mark still moving. Completed calls append their counts IN PLACE; the window below is the act itself, with its live output. This is the answer to “how does streaming work” — one line that grows. What it must not do is wear the settled form early: `✦ thought 4s · read 2 files` over live rows would be a finished record sitting on unfinished work.",
	[
		you("fix the flaky test in editor.test.ts — it only fails on the pty runner"),
		stretchLine("acting", [term("read_file",2,true), term("shell",1,true)], null, false),
		actHead("shell", "npm run check", "12s"),
		winRow("vitest run --project unit --reporter dot"),
		winRow("····················· 114 passed"),
		winEnd("live tail · esc stop · alt+⏎ redirect"),
		...chrome("", "", d(`${G.think} working 16s ↓ 1.8k tokens`), d("ctx left ~91%"), false),
	],
);

frame(
	"05 · acting — a fast call",
	"The same block with a call that will be over before you read it. kiso does NOT adopt the reference's 700ms eased hold on the hint: a minimum display time is animation smoothing, and this product shows facts on the event clock. The count bump on the line is the feedback that the call happened.",
	[
		you("fix the flaky test in editor.test.ts — it only fails on the pty runner"),
		stretchLine("acting", [term("read_file",3,true), term("search_text",1,true)], null, false),
		actHead("read", "packages/tui/src/editor.ts", "0s"),
		winRow("waiting for output"),
		winRow(""),
		winEnd(""),
		...chrome("", "", d(`${G.think} working 9s`), d("ctx left ~92%"), false),
	],
);

frame(
	"06 · three calls at once — the frame the owner corrected",
	"Parallel work replaces the head+window with one head per running call, capped, the overflow counted; the block's height stays fixed. THE CORRECTION: this frame used to read `✦ thought 2s · read 6 files` above these three live rows — the settled glyph and the past tense, over work still in flight. A summary is a record; a record of something that has not happened is a lie the eye reads before the words do. Present tense, moving mark, until the stretch closes.",
	[
		you("check the three packages"),
		stretchLine("acting", [term("read_file",6,true), term("shell",4,true)], null, false),
		actHead("shell", "npm run check -w core", "8s"),
		actHead("shell", "npm run check -w runtime", "8s"),
		actHead("shell", "npm run check -w tui", "7s"),
		winEnd("+1 more running"),
		...chrome("", "", d(`${G.think} working 11s`), d("esc stop"), false),
	],
);

frame(
	"07 · trouble, the moment it happens",
	"A failure lands ON THE LINE as a clause, in the failure colour, the instant the call settles — and it never leaves. This is strictly better than today, where the failed row scrolls up under the calls that follow it. The colour is emphasis; the words carry the fact (law 1.3), so a pipe keeps `1 failed: npm test · exit 1` in full.",
	[
		you("fix the flaky test in editor.test.ts — it only fails on the pty runner"),
		stretchLine("acting", [term("read_file",3,true)], "1 failed: npm test · exit 1", false),
		actHead("read", "packages/tui/tests/editor.test.ts", "1s"),
		winRow("waiting for output"),
		winRow(""),
		winEnd(""),
		...chrome("", "", d(`${G.think} working 21s`), d("esc stop"), false),
	],
);

frame(
	"08 · ctrl+r while it runs — a TRUE toggle",
	"On the OPEN block the key toggles in place, and a second press restores frame 04. This is where the reasoning is read in full — the thing today's one-line thinking fold cannot show. Explore runs group exactly as the rollup groups them, so the expansion and the commit path can never disagree.",
	[
		you("fix the flaky test in editor.test.ts — it only fails on the pty runner"),
		stretchLine("acting", [term("read_file",3,true), term("shell",1,true)], null, false),
		thinkRow("editor.test.ts polls a timer that races the frame scheduler; the pty"),
		thinkRow("suite stubs time, so the flake is the 16ms coalesce window — reproduce"),
		thinkRow("it first, then pin the scheduler seam"),
		`  ${d(cut("explored 3 files", W - 2))}`,
		`  ${d(cut(`${G.child} read   editor.ts · editor.test.ts · pty.ts`, W - 2))}`,
		actHead("shell", "npm run check", "12s"),
		winEnd("ctrl+r collapses"),
		...chrome("", "", d(`${G.think} working 16s`), d("ctx left ~91%"), false),
	],
);

// ═══ II · THE SETTLED HALF — what the scrollback keeps ════════════

frame(
	"09 · the fold commits",
	"The first byte of prose closes the stretch. The block collapses to its one line — the SAME line you were watching, minus nothing, plus the key — and commits into the terminal's real scrollback, ahead of the prose it led to. The settle changes the tense and the key, and nothing else: that is the whole point of building the live line as the fold.",
	[
		you("fix the flaky test in editor.test.ts — it only fails on the pty runner"),
		stretchLine("settled", ["thought 9s", "read 4 files", "listed 1 dir", "ran 4 shell commands"], null, true),
		prose("The flake is the 16ms coalesce window: the pty suite stubs the clock, so"),
		prose("two frames land in one tick and the assertion sees the second."),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"10 · the rhythm — the shape the owner photographed",
	"A whole settled turn. One summary per stretch, standing with the prose it led to; the recap at the end says the COST and never repeats the work. `directory` has compacted to `dir` — the owner's own sentence is 81 cells at W=80 and the ladder buys the one cell it needs, cheapest word first.",
	[
		you("look at this project"),
		stretchLine("settled", ["thought 8s"], null, true),
		prose("I'll read a few core files first, then give you the map."),
		stretchLine("settled", ["thought 10s", "read 4 files", "listed 1 dir", "ran 4 shell commands"], null, true),
		prose("kiso is a durable-execution agent: the kernel owns the schedule, the"),
		prose("runtime owns the log, and the TUI is a projection over both."),
		recap("took 21s · in 12.4k out 1.8k · cache 87% · ctx left ~91%"),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"11 · a stretch that only thought",
	"No tools, so no work terms — the reference's `Thought for 8s`, in kiso's voice, with the key that reopens the reasoning. Note what does NOT happen: no `thought 0s` on a stretch that did no thinking (R3h), and no zero terms anywhere.",
	[
		you("why does the pty runner disagree with the unit runner?"),
		stretchLine("settled", ["thought 8s"], null, true),
		prose("Because the pty runner shares one event loop with the driver, so a"),
		prose("blocking spawn starves the frame scheduler."),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"12 · one call is not a stretch",
	"A stretch of exactly one call and no thinking commits the call's OWN row instead of a fold. `shell npm run check (exit 0, 12.4s) · 82 lines · ctrl+r expands` says strictly more than `✦ ran 1 shell command` in the same one row — folding one row into one row is pure loss. The ≥2 rule is not on its own the cure for R3d's defect — frame 12b is where that is settled.",
	[
		you("run the check suite"),
		callRow("shell", "npm run check", "exit 0, 12.4s", "82 lines · ctrl+r expands"),
		prose("Green — 2258 tests, no failures."),
		recap("took 13s · in 1.1k out 90 · ctx left ~97%"),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"12b · thinking + ONE call — the shape R3d killed R3b over",
	"THE FRAME THIS PAGE WAS MISSING, and the state that decides whether R3d's defect comes back. A narrating model's commonest stretch is one thought and one call — two cells, so the ≥2 rule folds it, and folding it by COUNT gives `✦ thought 2s · read 1 file`: two rows replaced by a row that says less than either of them did. That is verbatim what the owner killed per-segment folds over. The ≥2 rule alone does NOT answer it. THE FIX: a stretch with exactly one call names its TARGET instead of its count — the line then says everything both rows said, and the per-break row becomes fully informative instead of a summary of nothing. Top: by count (what this page did before the review). Bottom: by target.",
	[
		you("what does the editor do with a paste?"),
		`  ${d(cut("BEFORE — by count, two rows for one, saying less:", W - 2))}`,
		stretchLine("settled", ["thought 2s", "read 1 file"], null, true),
		`  ${d(cut("AFTER — by target, everything both rows said:", W - 2))}`,
		stretchLine("settled", ["thought 2s", termOne("read_file", "editor.ts", false)], null, true),
		prose("It buffers the burst and submits it as ONE turn — the CRLF split is"),
		prose("the paste, not three messages."),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"12c · the quiet turn — where A9 already ruled",
	"A turn that ends with no prose at all is the ONE shape `turnFold` serves today, and this page had no frame for it. A9 (an owner ruling) puts the human's words ON the fold line as the chip, so the turn is one row. Frame 02 says the chip band “is never folded — nothing about this changes”, which contradicts A9: the ruling must either be kept here (the chip rides, as drawn) or superseded (band + fold = two rows where one stands today), and it cannot be decided by a page that does not draw it.",
	[
		stretchLine("settled", ["thought 3s", term("shell", 1, false)], null, true, "is the pty runner green?"),
		recap("took 14s · in 900 out 40 · ctx left ~98%"),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"13 · trouble folds, NAMED",
	"The owner's question, answered. Law 1.3 governs marks versus words — it never granted a failure a permanent row, and law 1.7 says work folds while words do not. So the work folds and the OUTCOME WORDS ride the line: which call, and what happened. Without pressing anything you know trouble occurred, on which call, and its outcome; behind the key is the stderr — detail, not outcome.",
	[
		you("write the env file and check"),
		stretchLine("settled", ["thought 9s", "read 20 files"], "1 denied: write .env", true),
		prose("I left .env alone. Here is what the other twenty files say."),
		stretchLine("settled", ["thought 3s", "read 2 files"], "interrupted", true),
		recap("took 34s · in 18.2k out 2.1k · cache 91% · ctx left ~88%"),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"14 · ctrl+r on a committed fold — an APPEND, and it says so",
	"Committed rows are ink: the terminal's own scrollback is the transcript, and ADR-0046 forbids rewriting history. So the reference's click-to-toggle is not available here and the design does not fake it — the key APPENDS a block at the bottom whose header names its origin, and a second press opens the next fold rather than closing this one. The footer says exactly that; today it says `ctrl+r collapses`, which is false in this path.",
	[
		stretchLine("settled", ["thought 9s", "read 4 files", "listed 1 dir", "ran 4 shell commands"], null, true),
		prose("The flake is the 16ms coalesce window."),
		`${b(G.fold)} ${d(cut("expanded · thought 9s · read 4 files · listed 1 dir · ran 4 shell commands · 1 turn back", W - 2))}`,
		thinkRow("editor.test.ts polls a timer that races the frame scheduler; the pty"),
		thinkRow("suite stubs time, so the flake is the 16ms coalesce window"),
		`  ${d(cut("explored 4 files · 1 dir", W - 2))}`,
		`  ${d(cut(`${G.child} read   compositor.ts · components.ts · render.ts (+1)`, W - 2))}`,
		`  ${d(cut(`${G.child} list   packages/tui`, W - 2))}`,
		callRow("shell", "npm run check", "exit 0, 12.4s", ""),
		`  ${d(cut(`${G.child} end of expansion · ctrl+r opens the next fold`, W - 2))}`,
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

// ═══ III · THE PANELS, AND THE THING kiso DOES NOT HAVE YET ═══════

frame(
	"15 · the approval",
	"Unchanged by this round — it is here so the page covers a whole turn. The panel IS the live region while it is up; the cursor row carries the arrow AND the reverse bar (the mark and the fact); the args are verbatim behind the gutter.",
	[
		you("clean the build directory"),
		`  ${cut(`${p("shell")} ${d("needs approval — asked by")} ${b("mode:default")}`, W - 2)}`,
		`  ${d(G.bar)} ${d(cut("$ rm -rf build", W - 4))}`,
		`  ${rv(cut(` ${G.cursor} 1 Yes, run it `, W - 2))}`,
		`    ${p(cut("2 Yes, and don't ask again for shell", W - 4))}`,
		`    ${p(cut("3 Show me safer ways to do this", W - 4))}`,
		`    ${p(cut("4 No — let me tell it what to do instead", W - 4))}`,
		...chrome(b("1-4> "), "", d(`${G.pause} run paused`), d("↑↓ move · ⏎ confirms · esc"), true),
	],
);

frame(
	"16 · the question",
	"Also unchanged. The status row carries the one line no competitor's panel can say: the answer is a durable fact, so it survives the crash that follows it.",
	[
		you("set up the release"),
		`  ${p(cut(ASK_Q, W - 12))}  ${d("‹ 1/2 ›")}`,
		`  ${d(cut("deploy target", W - 2))}`,
		`  ${rv(cut(` ${G.cursor} 1 staging            the current default in CI `, W - 2))}`,
		`    ${p(cut("2 production         requires the owner token", W - 4))}`,
		`    ${d(cut("t   type your own answer", W - 4))}`,
		...chrome(b("1-2> "), "", d(`${G.pause} question 1 of 2 · answers are durable facts`), d("t type · esc decline"), true),
	],
);

frame(
	"17 · the answer — NEW, kiso has nothing here today",
	"Today an answered ask settles as `ask_user (3 lines, 41.2s)` and the answers are invisible: the result already carries them as JSON, and the renderer throws them away. This is the owner's “after I answer, there is a display for that too”. The question is dim, the join is dim, the ANSWER is at body strength — strip every escape and the facts all survive. It is words, not work (law 1.7), so it closes the stretch exactly as prose does and never folds into the line.",
	[
		you("set up the release"),
		`  ${cut(`${p("asked 2 questions")} ${p("(answered, 41.2s)")}`, W - 2)}`,
		`  ${d(G.bar)} ${cut(`${d("deploy target")} ${d(G.arrow)} ${p("staging")}`, W - 4)}`,
		`  ${d(G.bar)} ${cut(`${d("retry policy")} ${d(G.arrow)} ${p("give up after 3 attempts")} ${d("(typed)")}`, W - 4)}`,
		prose("Staging it is. I'll wire the retry budget to three."),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

frame(
	"18 · the answer, declined",
	"The honest decline record: what went unanswered, and what the choices had been. The panel already computes both.",
	[
		you("set up the release"),
		`  ${cut(`${p("asked 2 questions")} ${p("(declined, 8.0s)")}`, W - 2)}`,
		`  ${d(G.bar)} ${d(cut("deploy target (staging, production)", W - 4))}`,
		`  ${d(G.bar)} ${d(cut("retry policy (give up after 3, retry forever)", W - 4))}`,
		prose("Understood — I'll leave both at their current defaults and say so in the PR."),
		...chrome("", "", d("ready"), d("/ commands · ↑ history")),
	],
);

// ═══ IV · THE EDGES — where a design earns its keep ══════════════

frame(
	"19 · the spill split — the honest degradation",
	"A screen too short to hold an open stretch force-commits part of it. Committed rows are ink, so the stretch SPLITS: the first line commits with its counts AS OF the split, and a fresh line continues with fresh counts. 9 + 2 is the stretch; neither line counts a row the other shows. CORRECTED AFTER REVIEW: this frame used to draw two individual read rows directly under the first fold line, which taught the opposite of the invariant it exists to defend — a reader could not tell whether `9 files` included the rows beneath it, and if it did, the fold was claiming work standing visible below it (the R3f disease). No orphan rows: the first line's work is behind its key, the second line's is in flight.",
	[
		stretchLine("settled", ["thought 4s", "read 9 files"], null, true),
		stretchLine("acting", [term("read_file", 2, true)], null, false),
		actHead("read", "packages/tui/src/editor.ts", "0s"),
		winRow("waiting for output"),
		winEnd("+9 earlier rows · ctrl+r"),
		...chrome("", "", d(`${G.think} working 9s`), d("esc stop"), false),
	],
);

frame(
	"20 · narrow — W=64",
	"The ladder at a width that hurts: the nouns compact cheapest-word-first, then the counts cut with the honest ellipsis. The trouble clause never gives way, and the key never gives way at all — a fold with no key is work with no way back to it.",
	[
		stretchLine("settled", ["thought 9s", "read 20 files", "listed 3 directories", "ran 6 searches"], "1 denied: write .env", true),
		prose("I left .env alone."),
		...chrome("", "", d("ready"), d("↑ history")),
	],
);

frame(
	"21 · palette off — the pipe contract",
	"Run this page with `--plain` and read it again: every fact above is carried by words. The failure is `1 denied: write .env`, not a colour; the outcome is `exit 1`, not a cross. Colour is emphasis, never information (law 1.2) — and this frame is the same rows with nothing to lean on.",
	[
		you("write the env file and check"),
		cut(`${G.fold} thought 9s · read 20 files · 1 denied: write .env · ctrl+r`, W),
		cut("I left .env alone. Here is what the other twenty files say.", W),
		cut(`${G.fold} took 34s · in 18.2k out 2.1k · cache 91% · ctx left ~88%`, W),
	],
);

// ═══ the renderers ═════════════════════════════════════════════════

// --check: the page asserts the invariant it claims to obey. A preview
// that shows a row wider than the terminal is a preview of a crash
// (invariant ①), and one that shows a row with a newline in it is a
// preview of the composer being smashed (invariant ①b, R3f).
if (argv.includes("--check")) {
	let bad = 0;
	let rows = 0;
	for (const f of FRAMES) {
		for (const row of f.rows) {
			rows += 1;
			if (/[\n\r]/.test(row)) {
				console.error(`[v9] \u2460b: a row is not ONE row — ${f.title}: ${JSON.stringify(row.slice(0, 60))}`);
				bad += 1;
			}
			const w = vw(row);
			if (w > W) {
				console.error(`[v9] \u2460: ${w} cells > W=${W} — ${f.title}: ${JSON.stringify(row.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 60))}`);
				bad += 1;
			}
		}
	}
	if (bad > 0) {
		console.error(`[v9] FAIL — ${bad} of ${rows} rows break the invariant at W=${W}`);
		process.exit(1);
	}
	console.log(`[v9] OK — ${FRAMES.length} frames, ${rows} rows, every one a single row within W=${W}`);
	process.exit(0);
}

if (!HTML) {
	for (const f of FRAMES) {
		process.stdout.write(`\n${d("─".repeat(W))}\n${checked(` ${b(f.title)}`, W)}\n${d("─".repeat(W))}\n\n${f.rows.map((r) => checked(r, W)).join("\n")}\n`);
	}
	process.stdout.write(`\n${d("─".repeat(W))}\n ${d(`width ${W} · ${PLAIN ? "plain (the pipe contract)" : "colored"}`)}\n`);
} else {
	const sections = FRAMES.map(
		(f, i) =>
			`<section class=f><div class=meta><span class=n>${String(i + 1).padStart(2, "0")} / ${FRAMES.length}</span><h2>${esc(f.title)}</h2><p>${md(f.note)}</p></div><div class=term><pre>${f.rows.join("\n")}</pre></div></section>`,
	).join("");
	process.stdout.write(`<!doctype html>
<html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>kiso · TUI v9 — the turn, as a state model</title>
<style>
  :root{--bg:#f7f7f5;--ink:#1a1a18;--soft:#6f6f66;--card:#ffffff;--line:#e3e3dc;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
  html[data-t=dark]{--bg:#111311;--ink:#e8e8e0;--soft:#8a8a80;--card:#191b19;--line:#2a2c2a}
  html[data-t=dark] .term{--t-bg:#141614;--t-fg:#d6d6cc;--t-dim:#7a7a70;--t-red:#e06050;--t-green:#7fc77a;--t-code:#9ab0d8;--t-bold:#f0f0e8;--t-car:#d6d6cc;--t-carfg:#141614}
  .term{--t-bg:#ffffff;--t-fg:#232320;--t-dim:#8a8a80;--t-red:#c03a2a;--t-green:#2f7d2a;--t-code:#3d5f9e;--t-bold:#11110f;--t-car:#11110f;--t-carfg:#ffffff}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font-family:var(--mono);line-height:1.5}
  .wrap{max-width:1180px;margin:0 auto;padding:44px 28px 80px}
  header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px}
  h1{font-size:22px;font-weight:600;letter-spacing:-.01em}
  h1 span{color:var(--soft);font-weight:400}
  .sub{color:var(--soft);font-size:13px;max-width:64ch;margin-top:8px}
  button{font:inherit;font-size:12px;color:var(--soft);background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer;white-space:nowrap}
  .rule{height:1px;background:var(--line);margin:26px 0 34px}
  section.f{display:grid;grid-template-columns:minmax(300px,320px) 1fr;gap:36px;padding:34px 0;border-top:1px solid var(--line)}
  .meta{order:2;position:sticky;top:32px;align-self:start}
  .n{font-family:var(--mono);font-size:11px;color:var(--soft);display:block;margin-bottom:10px}
  .meta h2{font-size:14.5px;font-weight:600;margin-bottom:9px;letter-spacing:-.01em}
  .meta p{font-size:13px;color:var(--soft)}
  .meta code{font-family:var(--mono);font-size:11.5px;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 4px}
  .term{order:1;background:var(--t-bg);border:1px solid var(--line);border-radius:10px;padding:20px 22px;overflow-x:auto;transition:background .15s}
  html[data-t=dark] .term{border-color:#2a2c2a}
  pre{font-family:var(--mono);font-size:12.5px;line-height:1.28;color:var(--t-fg);white-space:pre;letter-spacing:0}
  pre i{font-style:normal}
  .b{font-weight:600;color:var(--t-bold)} .d{color:var(--t-dim)} .r{color:var(--t-red)} .g{color:var(--t-green)} .k{color:var(--t-code)}
  .car{background:var(--t-car);color:var(--t-carfg)}
  .rv{background:var(--t-fg);color:var(--t-bg);padding:1px 0}
  .tbl{padding:52px 0}
  .tbl h2{font-size:14.5px;font-weight:600;margin-bottom:6px}
  .tbl>p{font-size:13px;color:var(--soft);margin-bottom:22px;max-width:60ch}
  table{border-collapse:collapse;font-size:13px;width:100%;max-width:620px}
  td{padding:9px 16px 9px 0;border-bottom:1px solid var(--line);vertical-align:baseline}
  td:first-child{font-family:var(--mono);width:130px;font-size:13px;color:var(--ink)}
  td:nth-child(2){font-size:12.5px;color:var(--soft)}
  td:last-child{font-family:var(--mono);font-size:11px;color:var(--soft);text-align:right;width:96px}
  footer{padding-top:44px;color:var(--soft);font-size:12.5px;font-family:var(--mono)}
  @media(max-width:1100px){section.f{grid-template-columns:1fr;gap:20px}.meta{order:1;position:static}.meta p{max-width:70ch}.term{order:2}}
</style></head><body><div class=wrap>
  <header>
    <div>
      <h1>kiso <span>· TUI v9 — the turn, as a state model</span></h1>
      <p class=sub>Twenty-one frames from one definition — this page and <code>node scripts/tui-v9-preview.mjs</code> render the same rows, so they cannot drift. Shown at 88 columns; <code>--width</code> re-renders at any width and <code>--check</code> asserts every row is ONE row inside it (invariants ① and ①b). Sections: <b>I</b> the streaming half — what is on screen while it works; <b>II</b> the settled half — what the scrollback keeps; <b>III</b> the panels and the answered question kiso has no rendering for today; <b>IV</b> the edges. Nothing here is built yet: design.md §8 says folding at a text boundary must not ride in a visual round, so the shape is settled here first.</p>
    </div>
    <button id=t>dark terminal</button>
  </header>
  <div class=rule></div>
  ${sections}
  <div class=tbl>
    <h2>The rejection asymmetry</h2>
    <p>Every human answer maps onto the existing chain verdicts — the durable <code>permission_decided</code> audit is untouched (the moat). Words keep the run alive; a bare No is the only abort.</p>
    <table>${[
			["bare 3 (No)", "deny — recorded, then the turn aborts", "abort"],
			["3 + tab + words", "deny(reason = the words) — the tool_result carries them", "continue"],
			["1 / y", "allow — normal execution", "continue"],
			["esc", "deny — ONE cancel line, treated as a denial", "continue"],
			["subagent deny", "a tool_result in the child's loop — the panel never appears (role policies never ask)", "never aborts"],
		].map(([a, b, c]) => `<tr><td>${esc(a)}</td><td>${md(b)}</td><td>${esc(c)}</td></tr>`).join("")}
    </table>
  </div>
  <footer>node scripts/tui-v8-preview.mjs --plain &nbsp;·&nbsp; the same frames, zero ANSI</footer>
</div>
<script>
  var h=document.documentElement,btn=document.getElementById('t');
  btn.onclick=function(){var dark=h.getAttribute('data-t')==='dark';h.setAttribute('data-t',dark?'light':'dark');btn.textContent=dark?'dark terminal':'light terminal'};
</script>
</body></html>
`);
}
