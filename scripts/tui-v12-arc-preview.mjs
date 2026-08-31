#!/usr/bin/env node
/**
 * kiso TUI v12 — THE WHOLE ARC, with D1 + D3 + D4 applied.
 *
 * This page exists because the rulings buried the thing the owner
 * actually asked to see: what the LIVE stream looks like. It has been
 * described three times in prose and never drawn.
 *
 * The one sentence the prose failed to say: **the live process is shown
 * in full, the whole time.** The running command, its output as it
 * arrives, the seconds ticking. The viewer is not a replacement for
 * that — it is how you go BACK to something that has already scrolled
 * past, and you only open it when you want to.
 *
 *   node scripts/tui-v12-arc-preview.mjs            # your width
 *   node scripts/tui-v12-arc-preview.mjs --plain    # zero SGR
 *   node scripts/tui-v12-arc-preview.mjs --check    # width self-proof
 */
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const PLAIN = argv.includes("--plain") || process.env.NO_COLOR !== undefined;
const wIdx = argv.indexOf("--width");
const W = Math.max(48, Math.min(110, wIdx >= 0 ? Number(argv[wIdx + 1]) : (process.stdout.columns || 82)));

const A = { b: "1", d: "2", rv: "7" };
const w = (r) => (t) => (PLAIN ? t : `\x1b[${A[r]}m${t}\x1b[0m`);
const b = w("b"), d = w("d"), rv = w("rv");
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
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
const chip = (t) => rv(` ${t} `.padEnd(W));
const rule = () => d("─".repeat(W));
const status = (t) => `${d("✧")} ${d(t)}`;

const FRAMES = [];
const frame = (title, note, rows) => FRAMES.push({ title, note, rows: rows.map(fit) });

// ─── the arc ────────────────────────────────────────────────────────
const chipRow = chip("how does the viewer stay out of the scrollback");

frame("1 · the turn opens — the block allocates ONCE",
	"This is the only time anything below the transcript moves for the rest of the turn. Six rows appear; from here they stay put.",
	[chipRow, "",
	 d("  thinking 4s"),
	 d("│ the viewer joins the overlay flag, so the window freezes"),
	 d("│ and no LF is emitted while it is up"),
	 d("│"), d("│"),
	 rule(), d(" › "), rule(),
	 status("working 4s · esc stop · alt+⏎ redirect · ctx left ~92%")]);

frame("2 · a command runs — you see it, and its output, live",
	"THE POINT THE PROSE KEPT MISSING: the live process is shown in full. The command, its output as it arrives, the seconds ticking. Nothing is hidden and nothing is deferred to the viewer.",
	[chipRow, "",
	 d("  thought 4s · running 1 shell command"),
	 `${b("●")} shell npm run check${d(" · 12s")}`,
	 d("│ tui-cells 94 passed"),
	 d("│ tui 181 passed"),
	 d("└ live tail · esc stop · alt+⏎ redirect"),
	 rule(), d(" › "), rule(),
	 status("working 16s · ↓ 1.8k tokens · ctx left ~91%")]);

frame("3 · it finishes, the answer streams — and NOTHING above moves",
	"The fold commits above a block that has not moved. The prose appends. In 0.19.0 this frame collapsed the block and the whole transcript slid down; here skip only ever grows, so the screen only ever moves up.",
	[chipRow, "",
	 d("  thought 4s · ran 1 shell command"), "",
	 "The check passes clean. Reading the store layer next.", "",
	 d("│"),
	 `  shell npm run check${d(" (exit 0, 12.4s) · 82 lines")}`,
	 d("│ 275 passed"),
	 d("│"),
	 rule(), d(" › "), rule(),
	 status("working 19s · ctx left ~90%")]);

frame("4 · the next stretch — the SAME rows, new contents",
	"This is where 0.19.0 jumped back up by six rows. Now the top row swaps from the pad to the stretch line and the body to the new thinking. Zero rows move.",
	[chipRow, "",
	 d("  thought 4s · ran 1 shell command"), "",
	 "The check passes clean. Reading the store layer next.", "",
	 d("  thinking 1s"),
	 d("│ store.ts holds the scroll floor; check who derives"),
	 d("│ committedLines…"),
	 d("│"),
	 rule(), d(" › "), rule(),
	 status("working 21s · ctx left ~90%")]);

frame("5 · the turn ends — one settle, and the answer is what you see",
	"The block releases once, at the moment the turn is over. No mark on any fold row; one star, on the recap, sealing the turn.",
	[chipRow, "",
	 d("  thought 4s · ran 1 shell command"), "",
	 "The check passes clean. Reading the store layer next.", "",
	 d("  thought 1s · read 2 files"), "",
	 "store.ts is strict about it — the floor is derived, never stored.", "",
	 `${b("✦")} took 76s${d(" · in 163 out 2k · cache 100% · ctx left ~87%")}`,
	 rule(), d(" › "), rule(),
	 d(" ▸ default · deepseek-v4-flash · ctx left ~87%")]);

frame("6 · ctrl+o — ONLY when you want to go back",
	"Not part of the flow. The entries are labelled by what each stretch was ABOUT — its own files and commands — so they are told apart at a glance. The counts are secondary.",
	[d("(the stream above is frozen, untouched)"),
	 d(`── transcript · 4 folds ${"─".repeat(Math.max(0, W - 24))}`),
	 `   npm run check${d(" · ran 1 shell command · thought 4s")}`,
	 `   store.ts, run.ts${d(" · read 2 files · thought 1s")}`,
	 ` ${b("▸")} loop.ts${d(" · read 1 file · thought 18s")}`,
	 `   session recovery notes${d(" · searched 2 patterns")}`,
	 rule(),
	 d(" ↑↓ move · ⏎ expands · a expands all · esc closes")]);

if (CHECK) {
	const bad = [];
	for (const f of FRAMES) for (const r of f.rows) {
		if (vis(r) > W) bad.push(`${f.title}: row wider than W=${W}`);
		if (/[\n\r]/.test(r)) bad.push(`${f.title}: row contains a newline`);
	}
	if (bad.length) { for (const x of bad) console.error(`FAIL  ${x}`); process.exit(1); }
	console.log(`[tui-v12] OK at W=${W} — ${FRAMES.length} frames, every row one row within W.`);
	process.exit(0);
}
for (const f of FRAMES) {
	console.log(`\n${PLAIN ? f.title : b(f.title)}`);
	console.log(`${PLAIN ? f.note : d(f.note)}\n`);
	for (const r of f.rows) console.log(r);
}
