#!/usr/bin/env node
/**
 * kiso TUI v7 — the design preview. ONE definition of every frame, two
 * renderers: ANSI (your terminal, the real medium) and HTML (a review
 * page you can look at). They cannot drift.
 *
 *   node scripts/tui-v7-preview.mjs                    # colored, your width
 *   node scripts/tui-v7-preview.mjs --plain            # zero SGR — the pipe contract
 *   node scripts/tui-v7-preview.mjs --width 64         # the narrow check
 *   node scripts/tui-v7-preview.mjs --html > out.html  # the review page
 *
 * The rule the preview exists to prove: every frame reads at full
 * strength with the palette OFF. Color is emphasis, never information.
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
const ANSI = { b: "1", d: "2", r: "31", g: "32", k: "38;5;110" };
const wrap = (role) => (t) => (HTML ? `<i class=${role}>${esc(t)}</i>` : PLAIN ? t : `\x1b[${ANSI[role]}m${t}\x1b[0m`);
const b = wrap("b"); // bold — identity and structure
const d = wrap("d"); // dim — metadata, hints, anything you can ignore
const r = wrap("r"); // red — failure, and nothing else
const g = wrap("g"); // green — diff additions, and nothing else
const k = wrap("k"); // code — inline backtick spans in kiso's prose
const p = (t) => (HTML ? esc(t) : t); // plain — the default weight
// REVERSE VIDEO (SGR 7). The only attribute that inverts using the
// TERMINAL'S OWN two colours, so it needs no theme detection: a light
// terminal paints dark-on-light, a dark terminal paints light-on-dark,
// and a user theme we have never seen still works. Closed with SGR 27,
// not SGR 0, so it composes with a surrounding bold/dim span.
const rv = (t) => (HTML ? `<i class=rv>${esc(t)}</i>` : PLAIN ? t : `\x1b[7m${t}\x1b[27m`);

// visible width: strips ANSI or HTML, so padding math is identical in both
const vw = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/<[^>]+>/g, "").replace(/&lt;|&gt;/g, "x").replace(/&amp;/g, "x").length;
const padR = (s, n) => s + " ".repeat(Math.max(0, n - vw(s)));
const padL = (s, n) => " ".repeat(Math.max(0, n - vw(s))) + s;
const cut = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

// ─── the wordmark. The PICTORIAL ring is out — at three rows it read as
// a hexagon, not as logo.svg. The block wordmark STAYS: it is the
// startup banner, and a startup banner is the point.
//
// What changes is the case. v6 spells KISO in caps; the brand wordmark
// is lowercase everywhere in kiso-work/index.html
// (<span class="logo-text">kiso</span>). Both sizes below are lowercase.
//
// BIG (6 rows) uses ONLY █ and space — no half-blocks, so there is no
// tile seam to lose in a font that renders ▀ ▄ at the wrong height.
// This is the default banner.
// Each pixel is TWO cells wide. A terminal cell is about 1:2, so a
// one-cell pixel would render a 4x6 letter at 1:3 — tall and spindly.
// Doubled, it lands at 8x6 cells = 2:3 on screen, which is the normal
// proportion of a capital.
const MARK_BIG = [
	"██    ██  ██████  ████████  ████████",
	"██  ██      ██    ██        ██    ██",
	"████        ██    ████████  ██    ██",
	"████        ██          ██  ██    ██",
	"██  ██      ██          ██  ██    ██",
	"██    ██  ██████  ████████  ████████",
];
// COMPACT is v6's own rows, UNCHANGED — they are already uppercase, so
// the small size needs no redraw and nothing about it regresses.
const MARK_SMALL = ["█ █ ▀█▀ █▀▀ █▀█", "█▀▄  █  ▀▀█ █ █", "▀ ▀ ▀▀▀ ▀▀▀ ▀▀▀"];
// the lowercase big cut, kept for the same-size A/B only.
const MARK_BIG_LOWER = [
	"██      ██                ",
	"██          ██████  ██████",
	"██  ██  ██  ██      ██  ██",
	"████    ██  ██████  ██  ██",
	"██  ██  ██      ██  ██  ██",
	"██  ██  ██  ██████  ██████",
];

/** The banner picks its size from the room it has — the same shape as
 *  bannerLines' existing "under 40 columns, skip the logo" rule. */
function markFor(width, rows) {
	if (width < 40 || rows < 14) return null;
	if (rows < 20) return MARK_SMALL;
	return MARK_BIG;
}
const ORBIT = ["▖", "▘", "▝", "▗"]; // the one animated glyph — a point orbiting a centre

// ─── the gutter: one column on every transcript row — except the user's,
// whose chip is the identity itself (the 2026-08-09 ruling retired the ▍ rail).
const G = { think: "⋯", queued: "◦", ok: "✓", fail: "✗", held: "⏸", head: "▞", child: "└" };
const NAMEW = 5; // read write edit shell list — the verb column

const you = (t) => `${rv(` ${t} `)}`; // the user message — the SGR-7 chip alone, flush left (the 2026-08-09 ruling)
const say = (t) => `  ${t}`;
const think = (t) => d(`${G.think} ${cut(t, W - 2)}`);
const row = (glyph, name, target, meta, paint) => {
	const head = `${paint(glyph)} ${padR(p(name), NAMEW)} `;
	const tail = meta ? ` ${d(`(${meta})`)}` : "";
	return `${head}${p(cut(target, Math.max(8, W - NAMEW - 3 - (meta ? meta.length + 3 : 0))))}${tail}`;
};
const queued = (n, t) => `${d(G.queued)} ${d(padR(n, NAMEW))} ${d(t)}`;
const running = (n, t, i, tail = []) => [row(ORBIT[i % 4], n, t, null, b), ...tail.map(child)];
const ok = (n, t, meta) => row(G.ok, n, t, meta, b);
const bad = (n, t, meta) => row(G.fail, n, t, meta, r);
const held = (n, t) => row(G.held, n, t, null, b);
const child = (t) => `  ${d(`${G.child} ${cut(t, W - 4)}`)}`;
// a bounded block belonging to the row above: │ continues, └ closes.
// The rows between them are ALWAYS the same count for a given state —
// that is the whole flow contract (see the doc, section 6).
const bodyRow = (t) => `  ${d("│")} ${d(cut(t, W - 4))}`;
const bodyEnd = (t) => `  ${d(`${G.child} ${cut(t, W - 4)}`)}`;
// the recap keeps v6's ▞ — with the pictorial mark gone there is no
// seal glyph to promote, and ▞ already means "a header in kiso's voice"
const recap = (t) => `${b(G.head)} ${d(t)}`;

// ─── the chrome. Four rows either way: CHROME_ROWS is untouched, so the
// live-region geometry and every gate keyed to H−4 stay exactly as they are.
const caretOn = HTML ? '<i class=car> </i>' : PLAIN ? "_" : "\x1b[7m \x1b[27m";
function boxChrome(text, statusL, statusR, caret = true) {
	const body = padR(`${b("›")} ${text}${caret ? caretOn : ""}`, W - 4);
	return [d(`╭${"─".repeat(W - 2)}╮`), `${d("│")} ${body} ${d("│")}`, d(`╰${"─".repeat(W - 2)}╯`), status(statusL, statusR)];
}
function railChrome(text, statusL, statusR) {
	return [d("╌".repeat(W)), `${b("▌")} ${p(text)}${caretOn}`, d("╌".repeat(W)), status(statusL, statusR)];
}
const status = (left, right) => `${left}${d(" ".repeat(Math.max(1, W - vw(left) - vw(right))) + right)}`;

// ═══ the frames ══════════════════════════════════════════════════════
const FRAMES = [];
const frame = (title, note, rows) => FRAMES.push({ title, note, rows });

/**
 * The preview has to obey the invariant it is describing. This is the
 * local stand-in for the compositor's #checked(line, W): walk the row,
 * copy SGR verbatim at zero width, cut once the visible width would
 * exceed W, and close any span left open.
 *
 * It exists because the frame CAPTIONS — long English sentences, not
 * design rows — were never width-managed: 14 rows blew past W at W=64,
 * 7 at W=72, 1 at W=88. The design rows themselves were always fine;
 * the scaffolding around them was not.
 */
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
		if (w + 1 > W) return out + (open ? "\x1b[0m" : "");
		out += line[i];
		w += 1;
		i += 1;
	}
	return out;
}

// 1 · the opening
const RESUME = [
	["2h ago", "fix the resize repaint storm", "41 events · 3 runs"],
	["today", "v6 one-compositor gates", "183 events · 12 runs"],
];
const metaW = Math.max(...RESUME.map((x) => x[2].length));
frame(
	"The opening",
	"The reference spends this space on “what’s new”. kiso survives kill -9 — so it spends the space on what you can pick back up. Every field already exists in `kiso sessions`.",
	[
		"",
		...MARK_BIG.map((m) => `  ${b(m)}`),
		"",
		// the art IS the wordmark, so the text line does not repeat the name
		`  ${d("v0.1.32  —  the coding agent that survives kill -9")}`,
		`  ${d("deepseek-v4-flash · ~/devv/kiso · mcp skills subagent task")}`,
		"",
		`  ${b(G.head)} ${d("resume")}`,
		...RESUME.map(([w, t, m]) => `    ${d(padR(w, 7))} ${padR(p(t), W - 13 - metaW)} ${d(padL(m, metaW))}`),
		"",
		...boxChrome("", d("ready"), "/ commands · ↑ history"),
	],
);

// 2 · in flight
frame(
	"In flight",
	"One gutter column carries every state, so the left edge alone reads the turn. The verb pads to 5 columns and the paths line up into something scannable. Metadata sits in parentheses — not in dim — because pipes and NO_COLOR get zero ANSI and must still read.",
	[
		you("fix the resize repaint storm"),
		"",
		think("the storm starts at the first feed — 3 marks on frame one, then +1 each (2.1k chars · /think)"),
		"",
		say(p("The repaint pushes committed rows back into the live region.")),
		say(p("Two things have to agree: the frame state and the screen state.")),
		"",
		ok("read", "packages/tui/src/compositor.ts", "912 lines, 0.2s"),
		ok("read", "5 files", "2.4k lines, 1.1s"),
		child("components.ts · render.ts · editor.ts"),
		child("+2 more — ctrl+r expands"),
		...running("shell", "npm test -w packages/tui", 1, ["✓ compositor.test.ts (41)", "✓ editor.test.ts (28)"]),
		queued("edit", "packages/tui/src/compositor.ts"),
		"",
		...boxChrome("", `${b("▘")}${d(" working · 4s · ↓12.4k · ctx 82%")}`, "esc to interrupt"),
	],
);

// 3 · approval
frame(
	"Approval",
	"The whole change sits above the box; the question goes inside it. You never approve something you cannot see — the existing rule from round 8, given a place to live.",
	[
		ok("read", "packages/tui/src/compositor.ts", "912 lines, 0.2s"),
		held("edit", "packages/tui/src/compositor.ts"),
		`  ${d("▎ 712")} ${r("- const menuTop = H - 3 - menuRows.length")}`,
		`  ${d("▎ 712")} ${g("+ const menuTop = H - CHROME_ROWS + 1 - menuRows.length")}`,
		"",
		...boxChrome(`${d("apply?")} ${b("y")}${d(" yes")}  ${b("a")}${d(" always")}  ${b("n")}${d(" no")}`, `${b(G.held)}${d(" edit_file needs you")}`, "esc to deny", false),
	],
);

// 4 · settled
frame(
	"Settled",
	"A failed tool keeps one child line — the reason — and nothing more. The recap closes the turn with numbers that all derive locally from the event stream, costing zero tokens.",
	[
		you("fix the resize repaint storm"),
		"",
		say(p("The frame state and the screen state disagreed after a resize.")),
		say(`${p("Fixed in ")}${k("`compositor.ts`")}${p(" — the repaint re-derives the live top.")}`),
		"",
		ok("read", "6 files", "1.3s"),
		ok("edit", "packages/tui/src/compositor.ts", "+9 -4, 0.1s"),
		ok("shell", "npm test -w packages/tui", "exit 0, 6.2s"),
		bad("shell", "npm run lint", "exit 1, 0.9s"),
		child("compositor.ts:712 — prefer-const"),
		"",
		recap("18s · 4 tools (1 edit) · in 12.4k out 1.8k · cache 61% · ctx left ~82%"),
		"",
		...boxChrome("", d("ready · deepseek-v4-flash"), "/ commands · ↑ history"),
	],
);

// 5 · the ladder
frame(
	"The collapse ladder",
	"The same five reads at four densities. Rungs 1–2 exist today. Rung 3 is the reference’s groupToolUses — group by the assistant message that issued the calls. Rung 4 folds a whole quiet turn once it is scrollback.",
	[
		d("live · the running tool keeps a short tail"),
		...running("shell", "npm test -w packages/tui", 2, ["compositor.test.ts (41 passed)", "editor.test.ts (28 passed)"]),
		"",
		d("settled · one row each — today’s v6 default"),
		ok("read", "packages/tui/src/compositor.ts", "912 lines"),
		ok("read", "packages/tui/src/components.ts", "376 lines"),
		ok("read", "packages/tui/src/render.ts", "457 lines"),
		ok("read", "packages/tui/src/editor.ts", "489 lines"),
		ok("read", "packages/tui/src/diff.ts", "147 lines"),
		"",
		d("rolled up · same turn + same tool + N over 2 → one row and its children"),
		ok("read", "5 files", "2.4k lines, 1.1s"),
		child("compositor.ts · components.ts · render.ts"),
		child("+2 more — ctrl+r expands"),
		"",
		d("folded · a whole quiet turn, once it is scrollback"),
		recap("thought 19s · 5 reads · no edits"),
	],
);

// 6 · the chrome A/B
frame(
	"The chrome — A/B",
	"Same width, same content, same four rows. A encloses the input and matches the brand’s 10px radius; inside it the prompt goes light, because the box already says “input lives here”. B is v6 today.",
	[
		d("A · the box"),
		"",
		...boxChrome("fix the resize repaint", d("ready · deepseek-v4-flash"), "/ commands · ↑ history"),
		"",
		"",
		d("B · the rails (v6 today)"),
		"",
		...railChrome("fix the resize repaint", d("ready · deepseek-v4-flash"), "/ commands · ↑ history"),
	],
);

// 7 · the banner — the two sizes, plus the case A/B at equal scale
frame(
	"The banner — two sizes, and the case A/B at equal scale",
	"BIG is 36x6 and uses only █, so there is no half-block seam to lose in a font that renders ▀ ▄ at the wrong height. COMPACT is v6's own three rows, unchanged — they are already uppercase, so the small size needs no redraw. The third block is the lowercase cut at the SAME size, which is the comparison the earlier draft never gave: it was arguing 3-row lowercase against 6-row caps.",
	[
		d("BIG · 36 x 6 — the default banner"),
		"",
		...MARK_BIG.map((m) => `  ${b(m)}`),
		"",
		`  ${d("v0.1.32  —  the coding agent that survives kill -9")}`,
		`  ${d("deepseek-v4-flash · ~/devv/kiso · mcp skills subagent task")}`,
		"",
		"",
		d("COMPACT · 15 x 3 — v6's rows, unchanged, for short windows"),
		"",
		...MARK_SMALL.map((m) => `  ${b(m)}`),
		"",
		`  ${d("v0.1.32  —  the coding agent that survives kill -9")}`,
		"",
		"",
		d("the lowercase cut at the same size — the site's own case, for reference"),
		"",
		...MARK_BIG_LOWER.map((m) => `  ${d(m)}`),
	],
);

// 8 · bounded blocks — the answer to "a big diff or a long run piling up"
frame(
	"Bounded blocks — the flow contract",
	"Measured, not asserted: truncateDiff caps at 37 source lines, which is 73 screen rows at width 80. Every cap here counts SCREEN rows after the fold, at the current width — the reference implementation's truncateToVisualLines rule. And a live block is a fixed-height window from its first frame, so a streaming tail repaints inside itself instead of shoving every row below it.",
	[
		d("a long run · the tail window, capped in screen rows"),
		ok("shell", "npm test -w packages/tui", "exit 0, 6.2s"),
		bodyRow("Test Files  6 passed (6)"),
		bodyRow("     Tests  183 passed (183)"),
		bodyRow("  Duration  6.19s"),
		bodyEnd("+240 earlier rows · ctrl+r"),
		"",
		d("the TOOL truncated · a different fact from the TUI truncating, so it gets its own row"),
		ok("read", "packages/core/src/kernel.ts", "200 of 3412 lines, 0.1s"),
		bodyEnd("capped by read_file · offset=200 for the rest"),
		"",
		d("a big diff · head and tail in screen rows, the middle named"),
		held("edit", "packages/tui/src/compositor.ts"),
		`  ${d("│")} ${d("708   const chromeRows = CHROME_ROWS + menuRows.length")}`,
		`  ${d("│")} ${r("712 - const menuTop = H - 3 - menuRows.length")}`,
		`  ${d("│")} ${g("712 + const menuTop = H - CHROME_ROWS + 1 - menuRows.length")}`,
		`  ${d("│")} ${d("713   for (let i = 0; i < menuRows.length; i += 1) {")}`,
		bodyEnd("+42 rows · ctrl+r to expand · /last for the full diff"),
		"",
		d("live · the window is the SAME height on frame one and at settle — nothing below it moves"),
		...running("shell", "npm test -w packages/tui", 0, []),
		bodyRow(""),
		bodyRow(""),
		bodyRow(""),
		bodyEnd("waiting for output"),
	],
);

// 9 · from opencode — the rhythm formula and the bounded subagent
frame(
	"Rhythm, and a nested session in two rows",
	"opencode's spacing is a formula, not taste: a blank appears before a row when that row is itself a block, or when the PREVIOUS sibling was taller than one row (util/layout.ts). One-row tools pack tight; blocks breathe. Its Task renderer is the other borrow — a whole child session bounded to the row plus one live line naming the child's current tool. kiso's delegate already returns toolCalls and outcome and shows neither.",
	[
		d("the rhythm formula · one-row rows pack; a block gets a blank on both sides"),
		ok("read", "packages/tui/src/render.ts", "457 lines"),
		ok("read", "packages/tui/src/editor.ts", "489 lines"),
		ok("read", "packages/tui/src/diff.ts", "147 lines"),
		"",
		ok("shell", "npm test -w packages/tui", "exit 0, 6.2s"),
		bodyRow("Test Files  6 passed (6)"),
		bodyRow("  Duration  6.19s"),
		bodyEnd("+240 earlier rows · ctrl+r"),
		"",
		ok("edit", "packages/tui/src/compositor.ts", "+9 -4, 0.1s"),
		ok("edit", "packages/tui/src/components.ts", "+4 -1, 0.1s"),
		"",
		d("a subagent · a nested session, bounded to two rows, height fixed while it runs"),
		...running("deleg", "explorer — map the compositor's commit path", 3, []),
		bodyEnd("read packages/tui/src/compositor.ts"),
		"",
		ok("deleg", "explorer — map the compositor's commit path", "42s"),
		bodyEnd("12 tool calls · 3 roles · 0 failed · /last for the report"),
	],
);

// 10 · the sent user message — three ways to mark it
// Only the SENT message changes; the input box is untouched.
const bandRows = (text) => {
	// full-width: every row padded to W so the band has a straight right
	// edge. foldLine already reopens an SGR span after a break, so a
	// wrapped band keeps its paint on every row.
	const rows = [];
	for (const line of foldPlain(text, W - 2)) rows.push(rv(padR(` ${line}`, W)));
	return rows;
};
const chipRows = (text) => {
	// the shipped form (2026-08-09 ruling): fold first, pad every row to
	// the longest + one space each side, flush left, SGR 27 close.
	const lines = foldPlain(text, W - 2);
	const inner = Math.max(...lines.map((l) => l.length));
	return lines.map((l) => `${rv(` ${padR(l, inner)} `)}`);
};
function foldPlain(text, max) {
	const out = [];
	for (const para of text.split("\n")) {
		let rest = para;
		while (rest.length > max) {
			let cutAt = rest.lastIndexOf(" ", max);
			if (cutAt <= 0) cutAt = max;
			out.push(rest.slice(0, cutAt));
			rest = rest.slice(cutAt).trimStart();
		}
		out.push(rest);
	}
	return out;
}
const SENT = "fix the resize repaint storm — the frame state and the screen state disagree after a resize";
frame(
	"The sent message — the chip, and the band it beat",
	"Reverse video (SGR 7) is the right primitive: it inverts using the terminal's OWN two colours, so a light terminal paints dark-on-light and a dark terminal paints the reverse, with no theme detection and no configured palette. Toggle this page's terminal to see both. It is an SGR, so pipes and NO_COLOR drop it — and the pipe path is the line-mode 'you>' form, which never renders the user message: the 2026-08-09 ruling retired the ▍ rail, leaving the chip alone, flush left.",
	[
		d("A · today — the SGR-7 chip, flush left (the 2026-08-09 ruling)"),
		"",
		...chipRows(SENT),
		"",
		say(p("The repaint pushes committed rows back into the live region.")),
		"",
		"",
		d("B · the full-width band — every row padded to W (the alternative)"),
		"",
		...bandRows(SENT),
		"",
		say(p("The repaint pushes committed rows back into the live region.")),
		"",
		"",
		d("the deciding case — a SHORT message, where the chip and the band stop looking alike"),
		"",
		...bandRows("/think"),
		say(p("…")),
		"",
		...chipRows("/think"),
		say(p("…")),
	],
);

// 11 · the shapes W7/W10 specify but no earlier frame drew, and the
// expand contract that the scrollback fork forces.
const elide = (t) => `  ${d(`│ ⋯ ${t}`)}`;
frame(
	"Expand, and the shapes the caps imply",
	"Three gaps closed. The 12-row diff cap needs a head/tail split with the middle NAMED — a number alone is not a spec. The 3-row error cap needs a shape. And ctrl+r cannot mean 'toggle' on this compositor: a committed cell's bytes are already in the terminal's native scrollback and #committedLines is the geometry, so changing a committed block's height desyncs the frame from the screen. Expansion therefore APPENDS — the idiom /last already uses.",
	[
		d("the 12-row diff · head + tail, the middle named, never a silent gap"),
		held("edit", "packages/tui/src/compositor.ts"),
		`  ${d("│")} ${d("706   const menuRows = this.#menuRows(W);")}`,
		`  ${d("│")} ${r("708 - let liveLines: string[] = [];")}`,
		`  ${d("│")} ${g("708 + const liveLines: string[] = [];")}`,
		`  ${d("│")} ${d("709   for (const cell of this.#cells.slice(...)) {")}`,
		elide("19 rows"),
		`  ${d("│")} ${d("744   out.push(`\\x1b[1G\\x1b[0K...`);")}`,
		`  ${d("│")} ${r("745 - out.push(`\\x1b[1A...`);")}`,
		`  ${d("│")} ${g("745 + out.push(`\\x1b[2A...`);")}`,
		bodyEnd("31 rows total · ctrl+r · /last for the full diff"),
		"",
		d("the 3-row error · head, because a stack's first frame is the one that matters"),
		bad("shell", "npm run lint", "exit 1, 0.9s"),
		`  ${d("│")} ${d("compositor.ts")}`,
		`  ${d("│")} ${d("  712:8  error  'menuTop' is never reassigned  prefer-const")}`,
		`  ${d("│")} ${d("  744:1  error  unexpected console statement    no-console")}`,
		bodyEnd("+11 rows · ctrl+r"),
		"",
		d("expand, on a LIVE cell · the compositor still owns those rows, so it toggles in place"),
		ok("shell", "npm test -w packages/tui", "exit 0, 6.2s"),
		bodyRow("Test Files  6 passed (6)"),
		bodyEnd("+240 earlier rows · ctrl+r"),
		"",
		d("expand, on a COMMITTED cell · the rows are already scrollback — so it APPENDS a fresh block"),
		you("ctrl+r"),
		"",
		`${b(G.head)} ${d("expanded · shell npm test -w packages/tui · 3 turns back")}`,
		bodyRow("… the full 243 rows, printed as new content at the bottom …"),
		bodyEnd("history is never rewritten — the one rule the compositor cannot bend"),
	],
);

// 12 · long-running off-loop work. Today /compact awaits summarize()
// with the status row unchanged — a silent multi-second freeze, and
// autoCompact fires it unprompted.
const bar = (done, total, width) => {
	const filled = Math.round((done / total) * width);
	return `${"▣".repeat(filled)}${"□".repeat(Math.max(0, width - filled))}`;
};
frame(
	"Long-running work — and the percentage kiso must not invent",
	"summarize() is ONE opaque adapter call: no chunking, no progress callback, so no honest fraction exists. An invented bar would break the same rule as a silent truncation. What IS knowable before the call — the round count, the token estimate — goes on the row, plus elapsed and the cancel key, because summarize() already takes a signal and the UI never exposed it. The determinate form is specified too, for operations that really do have an N of M.",
	[
		d("today · the status row does not change at all for the whole call"),
		you("/compact"),
		"",
		...boxChrome("", d("ready · deepseek-v4-flash"), "/ commands · ↑ history"),
		"",
		"",
		d("indeterminate · what is knowable up front, plus elapsed and the way out"),
		"",
		...boxChrome("", `${b("▘")}${d(" compacting · 12 rounds · ~48.2k tokens · 6s")}`, "esc to cancel"),
		"",
		"",
		d("determinate · ONLY where a real N of M exists — the bar is the checklist glyphs in a row, zero new vocabulary"),
		"",
		...boxChrome("", `${b("▝")}${d(` indexing · 8/17 files ${bar(8, 17, 14)} 47%`)}`, "esc to cancel"),
		"",
		"",
		d("settled · the recap idiom, replacing today's bare [/compact] notice"),
		recap("compacted · 12 rounds → 1 summary · saved ~48.2k · ctx 91% → 34% · 7.4s"),
	],
);

// 13 · the checklist — the one existing cell kind the round never touched
const taskRow = (glyph, text, paint) => `  ${paint(glyph)} ${p(cut(text, W - 4))}`;
frame(
	"The checklist — state, rendered as if it were an event",
	"body.checklist() pushes a NEW cell with done:true on every task_set, so each update commits another full copy to scrollback: 12 items over 10 updates is 130 rows of near-identical text. The component has no cap either, which breaks the very rule W7 sets. A task list is STATE — it belongs in one live block that redraws in place and commits once, exactly W8's window generalised. Active becomes ▸, which already means 'the current one' in the slash menu.",
	[
		d("today · unbounded, and a fresh copy every update"),
		`${b(G.head)} ${p("task")}`,
		taskRow("▣", "W7 — R1 caps in screen rows after the fold", d),
		taskRow("▖", "W8 — live block height never changes until settle", p),
		taskRow("□", "W9 — caps recomputed on resize, and only on resize", p),
		taskRow("□", "W10 — render the result body, name every cut", p),
		taskRow("□", "Release 1 → 0.1.36 (W7-W10) + gate re-baseline", p),
		d("  … and all of that again, committed, on the next task_set"),
		"",
		"",
		d("v7 · one live block · active first · done collapsed · committed once, at the end"),
		`${b(G.head)} ${p("task")} ${d("· 6 items · 1 active · 2 done")}`,
		taskRow("▸", "W8 — live block height never changes until settle", b),
		taskRow("□", "W9 — caps recomputed on resize, and only on resize", p),
		taskRow("□", "W10 — render the result body, name every cut", p),
		taskRow("□", "Release 1 → 0.1.36 (W7-W10) + gate re-baseline", p),
		bodyEnd("+2 done · ctrl+r"),
		"",
		"",
		d("settled · when the list is finished it commits ONCE, in the recap idiom"),
		recap("task done · 6 items · 2h 14m"),
	],
);

// ═══ the renderers ═══════════════════════════════════════════════════
if (!HTML) {
	for (const f of FRAMES) {
		const rows = f.rows.map((r) => checked(r, W)).join("\n");
		process.stdout.write(`\n${d("─".repeat(W))}\n${checked(` ${b(f.title)}`, W)}\n${d("─".repeat(W))}\n\n${rows}\n`);
	}
	process.stdout.write(`\n${d("─".repeat(W))}\n ${d(`width ${W} · ${PLAIN ? "plain (the pipe contract)" : "colored"}`)}\n`);
} else {
	const GUTTER = [
		[rv("you"), "you spoke — the SGR-7 chip: flush left, one space each side, no gutter (the 2026-08-09 ruling retired the ▍ rail)", "rv"],
		["&nbsp;", "kiso spoke — content is the default", "plain"],
		["⋯", "thinking, folded to one row", "dim"],
		["◦", "tool queued", "dim"],
		["▖▘▝▗", "tool running", "bold"],
		["✓", "tool settled", "bold"],
		["✗", "tool failed", "red"],
		["⏸", "tool waiting on you", "bold"],
		["▞", "a header in kiso’s voice", "bold"],
		["│", "a bounded block’s body — owned by the row above", "dim"],
		["└", "that block’s last row: what was cut, and where the rest is", "dim"],
	];
	const md = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/“|”/g, '"');
	const sections = FRAMES.map(
		(f, i) => `<section class=f>
      <div class=meta><span class=n>${String(i + 1).padStart(2, "0")}</span><h2>${esc(f.title)}</h2><p>${md(f.note)}</p></div>
      <div class=term><pre>${f.rows.join("\n")}</pre></div>
    </section>`,
	).join("\n");

	process.stdout.write(`<!doctype html>
<html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>kiso TUI v7 — design review</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --page:#eceeec; --card:#f8f9f8; --line:#e0e2e0; --ink:#141514; --soft:#6c706c;
    --t-bg:#f8f9f8; --t-fg:#141514; --t-bold:#000; --t-dim:#9b9e9b; --t-red:#a8342a; --t-green:#2f7d4f; --t-code:#3a6f9e; --t-car:#141514; --t-carfg:#f8f9f8;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
    --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,monospace;
  }
  html[data-t=dark]{
    --t-bg:#141514; --t-fg:#d3d6d3; --t-bold:#fbfcfb; --t-dim:#717571; --t-red:#e07a66; --t-green:#74c194; --t-code:#87afd7; --t-car:#d3d6d3; --t-carfg:#141514;
  }
  body{background:var(--page);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased;padding:0 24px 96px}
  .wrap{max-width:1080px;margin:0 auto}
  header{padding:88px 0 20px;display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex-wrap:wrap}
  h1{font-size:15px;font-weight:600;letter-spacing:-.01em}
  h1 span{color:var(--soft);font-weight:400}
  .sub{color:var(--soft);font-size:13.5px;max-width:56ch;margin-top:10px}
  button{font:inherit;font-size:12px;color:var(--soft);background:var(--card);border:1px solid var(--line);border-radius:8px;padding:7px 13px;cursor:pointer;font-family:var(--mono)}
  button:hover{color:var(--ink);border-color:#c8cac8}
  .rule{height:1px;background:var(--line);margin:28px 0 0}
  section.f{display:grid;grid-template-columns:1fr 300px;gap:36px;align-items:start;padding:52px 0;border-bottom:1px solid var(--line)}
  .meta{order:2;position:sticky;top:32px}
  .n{font-family:var(--mono);font-size:11px;color:var(--soft);display:block;margin-bottom:10px}
  .meta h2{font-size:14.5px;font-weight:600;margin-bottom:9px;letter-spacing:-.01em}
  .meta p{font-size:13px;color:var(--soft)}
  .meta code{font-family:var(--mono);font-size:11.5px;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:1px 4px}
  .term{order:1;background:var(--t-bg);border:1px solid var(--line);border-radius:10px;padding:20px 22px;overflow-x:auto;transition:background .15s}
  html[data-t=dark] .term{border-color:#2a2c2a}
  /* 1.28 ≈ a real terminal's cell. Block glyphs (▀ █ ▄) only tile
     seamlessly at a tight leading — at web leading they read as a
     smear, which would misrepresent the terminal. */
  pre{font-family:var(--mono);font-size:12.5px;line-height:1.28;color:var(--t-fg);white-space:pre;letter-spacing:0}
  pre i{font-style:normal}
  .b{font-weight:600;color:var(--t-bold)} .d{color:var(--t-dim)} .r{color:var(--t-red)} .g{color:var(--t-green)} .k{color:var(--t-code)}
  .car{background:var(--t-car);color:var(--t-carfg)}
  /* SGR 7 — inverts against the terminal's own pair, so it flips with
     the theme toggle exactly as a real terminal would.
     The padding is a PREVIEW-ONLY fidelity fix, not part of the design:
     a real terminal row is exactly one cell tall with no leading, so
     consecutive reverse-video rows tile seamlessly. Here the line box is
     16px while the painted inline box is 14.5px, so the 1.5px of leading
     showed through as a seam between rows. 1px top and bottom closes it
     with a hair of overlap, which is invisible on a solid fill.
     (Block glyphs like █ never had this problem — they are a GLYPH the
     font draws to fill the cell, not a CSS background.) */
  .rv{background:var(--t-fg);color:var(--t-bg);padding:1px 0}
  .tbl{padding:52px 0}
  .tbl h2{font-size:14.5px;font-weight:600;margin-bottom:6px}
  .tbl>p{font-size:13px;color:var(--soft);margin-bottom:22px;max-width:60ch}
  table{border-collapse:collapse;font-size:13px;width:100%;max-width:600px}
  td{padding:9px 16px 9px 0;border-bottom:1px solid var(--line);vertical-align:baseline}
  td:first-child{font-family:var(--mono);width:70px;font-size:13.5px;color:var(--ink)}
  td:last-child{font-family:var(--mono);font-size:11px;color:var(--soft);text-align:right;width:56px}
  footer{padding-top:44px;color:var(--soft);font-size:12.5px;font-family:var(--mono)}
  /* 88 columns needs ~680px of pane. Below (680 + 300 notes + 36 gap +
     48 padding) the two-column grid starts clipping frames, so stack
     instead of letting the terminal scroll sideways. */
  @media(max-width:1100px){section.f{grid-template-columns:1fr;gap:20px}.meta{order:1;position:static}.meta p{max-width:70ch}.term{order:2}}
</style></head><body><div class=wrap>
  <header>
    <div>
      <h1>kiso <span>· TUI v7 design review</span></h1>
      <p class=sub>Seven frames, rendered from the same definition that feeds the terminal preview — so this page and <code>scripts/tui-v7-preview.mjs</code> cannot drift. Shown at 88 columns.</p>
    </div>
    <button id=t>dark terminal</button>
  </header>
  <div class=rule></div>
  ${sections}
  <div class=tbl>
    <h2>The gutter</h2>
    <p>One column on every transcript row — except the user's, whose chip is the identity itself (the 2026-08-09 ruling retired the ▍ rail). Weight is emphasis; the glyph is the information, which is why all of it survives a pipe.</p>
    <table>${GUTTER.map(([gl, mean, weight]) => `<tr><td>${gl}</td><td>${esc(mean)}</td><td>${weight}</td></tr>`).join("")}</table>
  </div>
  <footer>node scripts/tui-v7-preview.mjs --plain &nbsp;·&nbsp; the same frames, zero ANSI</footer>
</div>
<script>
  var h=document.documentElement,btn=document.getElementById('t');
  btn.onclick=function(){var dark=h.getAttribute('data-t')==='dark';h.setAttribute('data-t',dark?'light':'dark');btn.textContent=dark?'dark terminal':'light terminal'};
</script>
</body></html>
`);
}
