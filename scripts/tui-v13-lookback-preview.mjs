#!/usr/bin/env node
/**
 * kiso TUI v13 — LOOKING BACK WITHOUT LEAVING THE RUN.
 *
 * The owner's objection to everything so far, and it is the right one:
 * nobody inspects a command after the run is over — you look WHILE it
 * is running. "Mid-stream I want to see the previous command, or what
 * was inside that thoughts fold, and I cannot."
 *
 * They also named both failure modes exactly: the reference/pi keeps
 * every command visible and it is elegant, but the commands eat an
 * enormous share of the stream; kiso folds them away and nothing can be
 * seen at all.
 *
 * The middle is already paid for. R6/D1 makes the act block STAND — a
 * fixed six rows for the whole turn. A fixed window whose contents swap
 * is a viewport, so give it a past: the same rows, showing an earlier
 * step. No mode, no append, no motion, no extra rows — and the running
 * work is still one keystroke away.
 *
 *   node scripts/tui-v13-lookback-preview.mjs
 *   node scripts/tui-v13-lookback-preview.mjs --plain
 *   node scripts/tui-v13-lookback-preview.mjs --check
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
const fit = (row) => { if (vis(row) <= W) return row; let o="",n=0;
  for (let i=0;i<row.length;){ if(row[i]==="\x1b"){const j=row.indexOf("m",i);o+=row.slice(i,j+1);i=j+1;continue;} if(n>=W-1)break; o+=row[i];n++;i++; } return `${o}…\x1b[0m`; };
const FRAMES = [];
const frame = (t, n, rows) => FRAMES.push({ t, n, rows: rows.map(fit) });
const chip = rv(` why is the CI job failing `.padEnd(W));
const rule = () => d("─".repeat(W));
const head = (a, bb) => [chip, "", d("  thought 4s · ran 1 shell command"), "",
  "The check passes clean. Reading the store layer next.", "", ...a, rule(), d(" › "), rule(), ...bb];

frame("1 · mid-run — the block shows what is happening NOW",
 "Six fixed rows. The command, its output as it arrives. This is the default and it never moves.",
 head([ d("  thought 1s · running 1 shell command"),
        `${b("●")} shell npm test -w tui-cells${d(" · 3s")}`,
        d("│ tui-cells 94 passed"), d("│ 12 skipped"),
        d("└ live tail · esc stop · alt+⏎ redirect") ],
      [ `${d("✧")} ${d("working 21s · ctrl+r looks back · ctx left ~90%")}` ]));

frame("2 · ctrl+r — the SAME rows show the step before",
 "No append, no mode, no motion. The block simply shows step 2 of 3 instead of the live one. The run keeps going behind it; the status row still ticks.",
 head([ `${d("  step 2 of 3")}${d(" · ran 1 shell command")}`,
        `  shell npm run check${d(" (exit 0, 12.4s)")}`,
        d("│ tui 181 passed"), d("│ 275 passed"),
        d("└ ctrl+r further back · ⏎ back to live") ],
      [ `${d("✧")} ${d("working 23s · looking back · ⏎ returns to live")}` ]));

frame("3 · ctrl+r again — the thinking of that step, in full",
 "This is what the owner could not reach: what was actually inside the thoughts. Same rows. Still no motion.",
 head([ `${d("  step 1 of 3")}${d(" · thought 4s")}`,
        d("│ the failing job pulls the rollup native binary in the"),
        d("│ CI-only verify step, which is where the lockfile's"),
        d("│ optional platform package never gets installed"),
        d("└ ctrl+r further back · ⏎ back to live") ],
      [ `${d("✧")} ${d("working 25s · looking back · ⏎ returns to live")}` ]));

frame("4 · ⏎ — straight back to live, mid-run",
 "One key returns. Nothing scrolled, nothing was appended to the transcript, and the run never paused.",
 head([ d("  thought 1s · running 1 shell command"),
        `${b("●")} shell npm test -w tui-cells${d(" · 9s")}`,
        d("│ tui 181 passed"), d("│ 275 passed"),
        d("└ live tail · esc stop · alt+⏎ redirect") ],
      [ `${d("✧")} ${d("working 27s · ctrl+r looks back · ctx left ~89%")}` ]));

frame("5 · why this beats both alternatives",
 "pi keeps every command on screen — elegant, but the commands own the stream. kiso folded them away — compact, but nothing is reachable. A standing block with a past costs the SAME six rows either way.",
 [ d("  the reference / pi          kiso 0.19.0            this"),
   d("  ─────────────────────       ──────────────         ──────────────"),
   d("  every command visible       counts only            six fixed rows"),
   d("  stream grows unbounded      stream is compact      stream is compact"),
   d("  look back: scroll up        look back: append      look back: in place"),
   d("  motion: constant            motion: per stretch    motion: none"),
   "",
   d("  ctrl+o's viewer still exists — for browsing a finished turn."),
   d("  This is the one for looking back WHILE it runs.") ]);

if (CHECK) {
  const bad = [];
  for (const f of FRAMES) for (const r of f.rows) {
    if (vis(r) > W) bad.push(`${f.t}: row wider than W=${W}`);
    if (/[\n\r]/.test(r)) bad.push(`${f.t}: newline in a row`);
  }
  if (bad.length) { for (const x of bad) console.error(`FAIL  ${x}`); process.exit(1); }
  console.log(`[tui-v13] OK at W=${W} — ${FRAMES.length} frames, every row one row within W.`);
  process.exit(0);
}
for (const f of FRAMES) {
  console.log(`\n${PLAIN ? f.t : b(f.t)}`);
  console.log(`${PLAIN ? f.n : d(f.n)}\n`);
  for (const r of f.rows) console.log(r);
}
