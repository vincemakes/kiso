#!/usr/bin/env node
/**
 * kiso TUI v11 — THE TRANSCRIPT VIEWER, on the primary screen.
 *
 * Not pi's, not the reference implementation's. Both of those put the
 * pointer first and pay for it: pi's viewer lives in the alternate
 * buffer, and its main-screen renderer erases the terminal's scrollback
 * to reflow. kiso gives up neither, so it needs a different answer.
 *
 * The answer: the thing the owner actually asked for is not a mouse,
 * it is "which one am I about to open". A committed row cannot be
 * marked — kiso never repaints it, by constitution — so the marker has
 * to live somewhere kiso DOES repaint. That is the viewer, and inside
 * it a keyboard cursor answers the question completely. The mouse then
 * becomes optional decoration rather than the mechanism.
 *
 * The viewer occupies the live region exactly as the keys sheet does
 * (TUI2-R1.5 7(a)): the window freezes, no LF is emitted, nothing
 * enters the scrollback, and closing restores every displaced row. No
 * alternate buffer, anywhere, ever.
 *
 *   node scripts/tui-v11-viewer-preview.mjs           # your width
 *   node scripts/tui-v11-viewer-preview.mjs --plain   # zero SGR
 *   node scripts/tui-v11-viewer-preview.mjs --check   # width self-proof
 */
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const PLAIN = argv.includes("--plain") || process.env.NO_COLOR !== undefined;
const wIdx = argv.indexOf("--width");
const W = Math.max(48, Math.min(110, wIdx >= 0 ? Number(argv[wIdx + 1]) : (process.stdout.columns || 84)));

const A = { b: "1", d: "2", rv: "7", tint: "48;5;236", cur: "38;5;110" };
const w = (role) => (t) => (PLAIN ? t : `\x1b[${A[role]}m${t}\x1b[0m`);
const b = w("b"), d = w("d"), rv = w("rv"), cur = w("cur");
/** the expanded block's background — a real tint, and under NO_COLOR
 *  the ▾ / │ gutter carries the same fact (law 1.3). */
const tint = (t) => (PLAIN ? t : `\x1b[${A.tint}m${t}${" ".repeat(Math.max(0, W - vis(t)))}\x1b[0m`);
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s, n) => s + " ".repeat(Math.max(0, n - vis(s)));
const rule = (label) => {
	const line = "─".repeat(Math.max(0, W - vis(label) - 3));
	return d(label === "" ? "─".repeat(W) : `─ ${label} ${line}`.slice(0, W + 40));
};

/** The prototype's rows are hand-written, so they get the product's own
 *  last resort — a hard cut at W — rather than a floor below which the
 *  page quietly lies. The real renderer folds through the R3i ladder
 *  first; this only has to be honest about never overflowing. */
const fit = (row) => {
	if (vis(row) <= W) return row;
	let out = "", n = 0;
	for (let i = 0; i < row.length; ) {
		if (row[i] === "\x1b") { const j = row.indexOf("m", i); out += row.slice(i, j + 1); i = j + 1; continue; }
		if (n >= W - 1) break;
		out += row[i]; n += 1; i += 1;
	}
	return `${out}…\x1b[0m`;
};
const FRAMES = [];
const frame = (title, note, rows) => FRAMES.push({ title, note, rows: rows.map(fit) });

frame(
	"1 · the live stream — unchanged, and no key printed",
	"This is 0.18.0 today. Four folds, none of them advertising anything. The rows are in the terminal's scrollback and kiso will never touch them again.",
	[
		rv(pad(" why does the CI job fail but not on my machine ", W)),
		`${b("✦")} thought 12s · listed 2 directories · ran 3 searches`,
		"Two candidates: the lockfile, or a CI-only verify step.",
		`${b("✦")} thought 9s · read 4 files · ran 2 searches`,
		"The rollup binary is optional and the lockfile",
		"never installs it on a clean runner.",
		`${b("✦")} thought 3s · ran 1 shell command`,
		"Fixed — the linux entry is in the lockfile now.",
		"",
		rule(""),
		d(" › ") + d("ask anything"),
		rule(""),
		d(" ▸ default · deepseek-v4-flash · ctx left ~87%"),
	],
);

frame(
	"2 · ctrl+o — the viewer opens IN the live region",
	"The window freezes, nothing scrolls, nothing enters the scrollback — the same discipline the ? keys sheet already ships. The cursor starts on the NEWEST fold, which is the one ctrl+r would have opened. That is the whole of “which one”: you can see it.",
	[
		d("(the stream above is still there, frozen, untouched)"),
		rule("transcript · 4 folds"),
		`   ${d("✦ thought 12s · listed 2 directories · ran 3 searches")}`,
		`   ${d("✦ thought 9s · read 4 files · ran 2 searches")}`,
		`${cur(" ▸ ")}${b("✦ thought 3s · ran 1 shell command")}`,
		`   ${d("✦ took 24s · in 163 out 2k · ctx left ~87%")}`,
		"",
		rule(""),
		d(" ↑↓ move · ⏎ expands · a expands all · esc closes"),
	],
);

frame(
	"3 · ⏎ — it expands IN PLACE, with a background",
	"The marker turns ▸ → ▾ and the block takes a background tint. Under NO_COLOR the ▾ and the │ gutter carry the same fact, so a pipe loses nothing. Nothing above moved.",
	[
		d("(the stream above is still there, frozen, untouched)"),
		rule("transcript · 4 folds"),
		`   ${d("✦ thought 12s · listed 2 directories · ran 3 searches")}`,
		`   ${d("✦ thought 9s · read 4 files · ran 2 searches")}`,
		tint(`${cur(" ▾ ")}${b("✦ thought 3s · ran 1 shell command")}`),
		tint(`   ${d("│ shell npm run check (exit 0, 12.4s)")}`),
		tint(`   ${d("│ tui-cells 94 passed")}`),
		tint(`   ${d("│ 275 passed")}`),
		`   ${d("✦ took 24s · in 163 out 2k · ctx left ~87%")}`,
		"",
		rule(""),
		d(" ↑↓ move · ⏎ collapses · a expands all · esc closes"),
	],
);

frame(
	"4 · ↑ — the cursor moves, and THAT is the answer to “which one”",
	"No mouse. No ordinal to type. You point with the same two keys you already use everywhere else in the product, and the thing you are about to open is lit. This is the frame the whole round exists for.",
	[
		d("(the stream above is still there, frozen, untouched)"),
		rule("transcript · 4 folds"),
		`   ${d("✦ thought 12s · listed 2 directories · ran 3 searches")}`,
		`${cur(" ▸ ")}${b("✦ thought 9s · read 4 files · ran 2 searches")}`,
		tint(`   ${d("▾ ✦ thought 3s · ran 1 shell command")}`),
		tint(`   ${d("│ shell npm run check (exit 0, 12.4s)")}`),
		tint(`   ${d("│ 275 passed")}`),
		`   ${d("✦ took 24s · in 163 out 2k · ctx left ~87%")}`,
		"",
		rule(""),
		d(" ↑↓ move · ⏎ expands · a expands all · esc closes"),
	],
);

frame(
	"5 · the viewer is ALSO the reflow answer",
	"Resize to 56 columns and the viewer re-wraps everything it shows, because it renders from the cells, not from bytes. The scrollback copy stays the immutable original — this is the surface you re-read on.",
	[
		d("(same session, terminal narrowed)"),
		rule("transcript · 4 folds"),
		`   ${d("✦ thought 12s · listed 2 dirs · ran 3 searches")}`,
		`${cur(" ▸ ")}${b("✦ thought 9s · read 4 files · ran 2 searches")}`,
		`   ${d("✦ thought 3s · ran 1 shell command")}`,
		"",
		rule(""),
		d(" ↑↓ move · ⏎ expands · esc closes"),
	],
);

frame(
	"6 · esc — every displaced row comes back",
	"The close takes the full-redraw path with the frozen skip, exactly as the keys sheet's gate already asserts: ZERO rows scrolled away, the screen byte-identical to frame 1.",
	FRAMES[0].rows,
);

if (CHECK) {
	const bad = [];
	for (const f of FRAMES) for (const r of f.rows) {
		if (vis(r) > W) bad.push(`${f.title}: row wider than W=${W}: ${JSON.stringify(r.replace(/\x1b\[[0-9;]*m/g, ""))}`);
		if (/[\n\r]/.test(r)) bad.push(`${f.title}: row contains a newline`);
	}
	if (bad.length) { for (const x of bad) console.error(`FAIL  ${x}`); process.exit(1); }
	console.log(`[tui-v11] OK at W=${W} — ${FRAMES.length} frames, every row one row within W.`);
	process.exit(0);
}
for (const f of FRAMES) {
	console.log(`\n${PLAIN ? f.title : b(f.title)}`);
	console.log(`${PLAIN ? f.note : d(f.note)}\n`);
	for (const r of f.rows) console.log(r);
}
