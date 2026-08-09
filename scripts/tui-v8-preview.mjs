#!/usr/bin/env node
/**
 * kiso TUI v8 — the approval & input round: the design preview. ONE
 * definition of every frame, two renderers: ANSI (your terminal, the
 * real medium) and HTML (a review page you can look at). They cannot
 * drift.
 *
 *   node scripts/tui-v8-preview.mjs                    # colored, your width
 *   node scripts/tui-v8-preview.mjs --plain            # zero SGR — the pipe contract
 *   node scripts/tui-v8-preview.mjs --width 64         # the narrow check
 *   node scripts/tui-v8-preview.mjs --html > out.html  # the review page
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
const G = { head: "▞", run: "▸", ok: "✓", fail: "✗", queued: "□", child: "└", bar: "│" };

const you = (t) => `${rv(` ${t} `)}`; // the user chip — the SGR-7 chip alone, flush left (the W16 ruling)
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
		`  ${d(G.bar)} ${d("─ the full args — never truncated ─")}`,
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
	const body = padR(`${lead}${line}${caret ? caretOn : ""}`, W - 4);
	return [d(`╭${"─".repeat(W - 2)}╮`), `${d("│")} ${body} ${d("│")}`, d(`╰${"─".repeat(W - 2)}╯`), status(statusL, statusR)];
}
const status = (left, right) => `${left}${d(" ".repeat(Math.max(1, W - vw(left) - vw(right))) + right)}`;
const idle = (right) => chrome(b("› "), "", d("ready"), d(right));

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

// the CJK demonstration line — the dogfood session's first turn,
// built from escapes (the tracked tree stays CJK-free)
const CJK_LINE = "\u4f60\u597d\uff0c\u5e2e\u6211\u770b\u770b\u8fd9\u4e2a\u9879\u76ee";

// 1 · today's surface (the baseline — what the panel replaces)
frame(
	"Before — today's y/n surface",
	"Today: `approve <name>? (y/n)` at the input line, the ⏸ detail row above it, and a free-standing `  approved` row once you answer (A5's orphan). No feedback channel, no why-asked line, no don't-ask-again — and the verdict paints three separate lines.",
	[
		you("review the approval flow in kiso"),
		`  ${d("⏸")} write_file needs approval`,
		`  ${d(G.bar)} ${d("write examples/foo.ts")}`,
		`  ${d(G.bar)} ${d("const greeting = \"hello kiso\";")}`,
		`  ${d(G.bar)} ${d("export function hello(): string {")}`,
		`  ${d(G.bar)} ${d("  return greeting;")}`,
		`  ${d(G.bar)} ${d("}")}`,
		...chrome(`${b("approve write_file? (y/n)")} `, "", d("▸ run paused"), d("/mode · ctrl+r")),
		`  approved`,
	],
);

// 2 · the panel — write_file
frame(
	"The panel — write_file (the rule line, the full content)",
	"The panel: a ONE-line rule row (the why-asked line — decidedBy + the fix hint), the title, the ALWAYS-verbose args (the full content, never truncated), the numbered options, and the affordance line. The input row hosts the interaction: digit keys jump, `y`/`n` are the 1/3 shortcuts, `esc` cancels.",
	[
		you("review the approval flow in kiso"),
		...panelBlock(
			panelRule("write_file", "mode:default", "/mode accept-edits"),
			"write examples/foo.ts",
			[
				`const greeting = ${g("\"hello kiso\"")};`,
				`export function hello(): string {`,
				`  return greeting;`,
				`}`,
			],
			0,
		),
		...chrome(b("1-3> "), "", d("▸ run paused"), d("tab amend · esc cancel")),
	],
);

// 3 · the panel — edit_file (the structured diff)
frame(
	"The panel — edit_file (the 3-context diff)",
	"edit_file's args are the structured diff with THREE context lines each side of the change — full, untruncated. Red is the deletion, green the addition; both survive a pipe as text.",
	[
		you("review the approval flow in kiso"),
		...panelBlock(
			panelRule("edit_file", "mode:default", "/mode accept-edits"),
			"edit examples/foo.ts",
			[
				`@@ examples/foo.ts · one hunk`,
				` ${d("│")} const greeting = ${r("\"hello\";")}`,
				` ${d("│")} ${g("+const greeting = \"hello kiso\";")}`,
				` ${d("│")} export function hello(): string {`,
				` ${d("│")}   return greeting;`,
				` ${d("│")} }`,
			],
			0,
		),
		...chrome(b("1-3> "), "", d("▸ run paused"), d("tab amend · esc cancel")),
	],
);

// 4 · the panel — shell (the full command)
frame(
	"The panel — shell (the full command)",
	"shell's args are the full command, never truncated — the human is never asked to approve a cut-down command. The why-asked line names safe-defaults when a policy extension asked.",
	[
		you("review the approval flow in kiso"),
		...panelBlock(
			panelRule("shell", "safe-defaults", "~/.kiso/extensions/safe-defaults.mjs"),
			"shell",
			[
				`$ git diff --stat packages/tui/src/compositor.ts packages/tui/src/render.ts`,
				`$ git status --porcelain`,
			],
			0,
		),
		...chrome(b("1-3> "), "", d("▸ run paused"), d("tab amend · esc cancel")),
	],
);

// 5 · option 2 — the editable rule input
frame(
	"Option 2 — the editable rule input",
	"Option 2 expands the INPUT ROW into an editable rule input: the lead names the option, the line is pre-filled with the tool name, the cursor sits at the end. The user edits before committing — the rule is whatever they commit, and the durable record names it (`decidedBy: dont-ask-again`).",
	[
		you("review the approval flow in kiso"),
		...panelBlock(
			panelRule("write_file", "mode:default", "/mode accept-edits"),
			"write examples/foo.ts",
			[
				`const greeting = ${g("\"hello kiso\"")};`,
				`export function hello(): string {`,
				`  return greeting;`,
				`}`,
			],
			2,
		),
		...chrome(`${d("2 Yes, don't ask again for ")}${b("write_file")}`, "", d("▸ rule input"), d("enter commits · esc backs out")),
	],
);

// 6 · tab-amend on Yes
frame(
	"Tab-amend on Yes — the feedback input",
	"Tab on any option expands the feedback input. On Yes: 'tell kiso what to do next' — the words ride the approval and stay visible in the transcript.",
	[
		you("review the approval flow in kiso"),
		...panelBlock(
			panelRule("write_file", "mode:default", "/mode accept-edits"),
			"write examples/foo.ts",
			[
				`const greeting = ${g("\"hello kiso\"")};`,
				`export function hello(): string {`,
				`  return greeting;`,
				`}`,
			],
			1,
		),
		...chrome(`${d("feedback (amend): ")}${b("also fix the tests")}`, "", d("▸ amend · the words ride the verdict"), d("enter sends")),
	],
);

// 7 · tab-amend on No — the denial with words
frame(
	"Tab-amend on No — the denial with words",
	"On No: '…what to do differently'. The words ride the DENIAL — the tool_result carries `[Permission denied] <the words>` and the run CONTINUES, so the model can adjust. This is the rejection asymmetry: words keep the run alive.",
	[
		you("review the approval flow in kiso"),
		...panelBlock(
			panelRule("write_file", "mode:default", "/mode accept-edits"),
			"write examples/foo.ts",
			[
				`const greeting = ${g("\"hello kiso\"")};`,
				`export function hello(): string {`,
				`  return greeting;`,
				`}`,
			],
			3,
		),
		...chrome(`${d("feedback (deny): ")}${b("don't touch the lockfile")}`, "", d("▸ deny · the words become the tool_result"), d("enter sends")),
		`  ${d(G.bar)} ${d("[Permission denied] don't touch the lockfile — the run continues")}`,
	],
);

// 8 · bare No — the turn aborts
frame(
	"Bare No — the turn aborts",
	"Bare No — no words — is the asymmetry's other side: the verdict is recorded first (the audit is the moat), then the TURN aborts. No retry. One aggregated row, one aborted terminal — never a triple. Subagent denials never abort: role policies never ask, so the panel structurally cannot host one.",
	[
		you("review the approval flow in kiso"),
		`  ${d(G.run)} ${p("write_file")} ${d("needs approval — asked by")} ${b("mode:default")}`,
		`  ${r(G.fail)} ${p("denied by user — no feedback, the turn aborts")}`,
		`  ${d("[aborted by user]")}`,
		...idle("/ commands · ↑ history"),
	],
);

// 9 · esc — cancel is one line
frame(
	"esc — cancel is one line",
	"esc cancels as ONE line — `[approval cancelled — treated as a denial]` — and nothing else. The approved/cancelled/denied triple is banned by construction: the A5 aggregation binds the verdict into the tool cell.",
	[
		you("review the approval flow in kiso"),
		`  ${d(G.run)} ${p("write_file")} ${d("needs approval — asked by")} ${b("mode:default")}`,
		`  ${d("[approval cancelled — treated as a denial]")}`,
		...idle("/ commands · ↑ history"),
	],
);

// 10 · the queue — pending chips pre-render
frame(
	"The queue — pending chips pre-render",
	"Human-typed input ALWAYS renders (the visibility invariant). While a run streams, typed turns pre-render ABOVE the input row as pending chips — the SAME chip component (W16: the chip never dims — reverse video inverts the current colours, so the queued state is carried by the `□` gutter mark, like every other state on the left edge). The status hint counts the queue.",
	[
		you("review the approval flow in kiso"),
		`  ${b(G.run)} ${padR(p("search_text"), 12)} ${p("the permission_decided schema")} ${d("(2s · running)")}`,
		`  ${d(G.queued)} ${rv(" fix the tests ")}`,
		`  ${d(G.queued)} ${rv(" then run the gates ")}`,
		...chrome(b("› "), "", d("▸ default · deepseek-v4-flash"), d("+2 queued · ↑ to edit")),
	],
);

// 11 · ↑ / esc — pop back into the editor
frame(
	"↑ / esc — pop back into the editor",
	"↑ (or esc) pops the LAST queued message back into the editor — the chip leaves the queue, the line returns, the cursor sits at the end. Repeated ↑ walks older queued messages.",
	[
		you("review the approval flow in kiso"),
		`  ${b(G.run)} ${padR(p("search_text"), 12)} ${p("the permission_decided schema")} ${d("(2s · running)")}`,
		`  ${d(G.queued)} ${rv(" then run the gates ")}`,
		...chrome(`${b("› ")} ${b("fix the tests")}`, "", d("▸ default · deepseek-v4-flash"), d("1 queued · esc to pop")),
	],
);

// 12 · the cursor contract — CJK
frame(
	"The cursor contract — CJK (the frame derives the column)",
	"The marker column derives from the FRAME: wall + leadWidth + displayCursor, and a CJK char is 2 cells. Here the cursor sits at char 3 (the first three glyphs of the line), so the marker sits at display column 10 — 2 walls + 2 lead + 6 cells. The afterW math (`1 + PROMPT_WIDTH + cursor`) placed it at 6 — four cells early. The glyphs of this frame are escaped in the source (the tree ruling); the line is the dogfood session's first turn.",
	[
		you("review the approval flow in kiso"),
		...chrome(`${b("› ")} ${insertCaret(CJK_LINE, 6)}`, "", d("▸ typing"), d("display col 10 = 2 walls + 2 lead + 6 cells"), false),
	],
);

// 13 · the cursor contract — the question lead
frame(
	"The cursor contract — the question lead",
	"The same contract under the question lead: the marker derives from the frame's ACTUAL lead (24 cells), not the brick's 2. The old assumption sat the cursor 22 cells early — and the editor's line cap followed the brick, so a long answer overran the frame (an invariant-① trip). The cap follows the lead: `maxW = W − walls − leadWidth(lead)`.",
	[
		you("review the approval flow in kiso"),
		...chrome(`${b("approve write_file? (y/n)")} ${insertCaret("y", 27)}`, "", d("▸ answering"), d("the marker = wall + leadWidth(question) + cursor"), false),
	],
);

// 14 · A9 mock A — the chip rides the fold
frame(
	"A9 mock A — the chip rides the fold",
	"RULING REQUEST — does the W14 fold keep the user chip? Mock A: the chip rides the fold — a folded turn is ONE row, the human's words lead it. The words take the fold's width budget (metadata rules apply to them).",
	[
		`  ${b(G.head)} ${rv(" any idea what the flaky gate is? ")} ${d("· thought 19s · 5 reads · no edits")}`,
		...chrome(b("› "), "", d("ready"), d("/ commands · ↑ history")),
	],
);

// 15 · A9 mock B — the chip separate
frame(
	"A9 mock B — the chip separate",
	"RULING REQUEST — mock B: the chip stays its own cell — the fold is the activity rollup only. Two rows for a talkative turn; the one-line promise holds only for quiet turns.",
	[
		rv(" any idea what the flaky gate is? "),
		`  ${b(G.head)} ${d("thought 19s · 5 reads · no edits")}`,
		...chrome(b("› "), "", d("ready"), d("/ commands · ↑ history")),
	],
);

// 16 · W19 — the recap fold fixed
frame(
	"W19 — the recap fold fixed",
	"The plan branch dropped the metadata (ctx left) BEFORE folding, and the recap obeys the status row's cut rule — 80 cols at W=80, never 95. The ctx-left hint lives where it always lived: the status row's right side.",
	[
		you("review the approval flow in kiso"),
		`  ${b(G.head)} ${d("plan ready · /mode default executes · /mode accept-edits auto-approves edits")}`,
		...chrome(b("› "), "", d("▸ plan"), d("ctx left ~43% · /mode default")),
	],
);

// 17 · D4 — the truncation notice
frame(
	"D4 — the truncation notice",
	"A max_tokens-truncated answer today renders NOTHING after the partial text — the cut is silent. The notice row names it (the truncation-guard philosophy: the cut is never silent), and the answer stays visible.",
	[
		you("review the approval flow in kiso"),
		`  ${d("the review found three issues in the permission path:")}`,
		`  ${d("the orphan verdict row (A5), the missing target")}`,
		`  ${d("column (A4), and the fold-repeat header (A6).")}`,
		`  ${d(G.child)} ${d("answer truncated at max_tokens — say \"continue\" to finish")}`,
		...chrome(b("› "), "", d("▸ default"), d("/mode · ctrl+r")),
	],
);

// 18 · A7 — the duplicate blocks, one copy
frame(
	"A7 — the duplicate blocks, one copy",
	"The reviewer's 0.1.40 dogfood session — 94 text_delta of a long streaming answer — duplicated the answer in scrollback. The live→commit seam emitted twice (the V6-1 lesson: a draw that does not cover every row leaves shifted copies). The fix: the seam emits ONCE — a replay of the session's events renders one copy.",
	[
		you("review the approval flow in kiso"),
		`  ${d("the review found three issues in the permission path:")}`,
		`  ${d("the orphan verdict row (A5), the missing target")}`,
		`  ${d("column (A4), and the fold-repeat header (A6). The")}`,
		`  ${d("seam duplication (A7) is the compositor's live→commit")}`,
		`  ${d("boundary — it must emit each committed row exactly once.")}`,
		`  ${d(G.child)} ${d("the rest of the answer · settled")}`,
		...chrome(b("› "), "", d("▸ default"), d("/mode · ctrl+r")),
	],
);

// 19 · A5 — the verdict row aggregates
frame(
	"A5 — the verdict row aggregates",
	"The verdict binds into the tool cell's head row — name + status + asked-by in ONE row. No free-standing `  approved` / `  denied:` cells anywhere in the scrollback; the cancel is one line, never the approved/cancelled/denied triple.",
	[
		you("review the approval flow in kiso"),
		`  ${g(G.ok)} ${p("write_file")} ${d("approved · asked by")} ${b("mode:default")}`,
		`  ${d(G.bar)} ${d("write examples/foo.ts — 14 lines")}`,
		...idle("ready"),
	],
);

// 20 · A6 — headers cut, never folded
frame(
	"A6 — headers cut, never folded",
	"Tool headers are widthCut, never foldLine — a wide header cuts with the ellipsis on ONE row instead of repeating its fold on wrap (the ✗ fold-repeat). Content folds; metadata cuts.",
	[
		you("review the approval flow in kiso"),
		`  ${b(G.run)} ${padR(p("edit_file"), 10)} ${p(cut("edit packages/tui/src/components.ts — the permission_decided orphan-row aggregation (A5) and the settled-success target column (A4)", 66))}`,
		...chrome(b("› "), "", d("▸ running"), d("/mode · ctrl+r")),
	],
);

// 21 · A8 — the boundary, no blank pileups
frame(
	"A8 — the boundary, no blank pileups",
	"The W11 boundary clears its rows on every steady draw — real interleavings (the dogfood session's) no longer pile blank rows at the boundary. Same coverage discipline as A7: every draw covers every row.",
	[
		you("review the approval flow in kiso"),
		`  ${d("the seam audit is complete — one copy, no orphans.")}`,
		`  ${b(G.run)} ${padR(p("edit_file"), 10)} ${p("edit packages/tui/src/compositor.ts")} ${d("(3s · running)")}`,
		`  ${d(G.bar)} ${d("the live window — steady, bounded, no gaps")}`,
		`  ${d(G.bar)} ${d("the boundary clears on every draw")}`,
		...chrome(b("› "), "", d("▸ running"), d("/mode · ctrl+r")),
	],
);

// ═══ the renderers ═════════════════════════════════════════════════

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
<title>kiso · TUI v8 approval &amp; input design review</title>
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
      <h1>kiso <span>· TUI v8 approval &amp; input design review</span></h1>
      <p class=sub>Twenty-one frames, rendered from the same definition that feeds the terminal preview — so this page and <code>scripts/tui-v8-preview.mjs</code> cannot drift. Shown at 88 columns. The approval panel, the visibility invariant, the cursor contract, the render-bug work items — 0.1.41.</p>
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
