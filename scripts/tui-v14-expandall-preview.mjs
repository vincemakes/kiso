#!/usr/bin/env node
/**
 * kiso TUI v14 — ctrl+r EXPANDS EVERYTHING, ctrl+r CLOSES IT.
 *
 * The owner's proposal, and it is better than the three designs before
 * it: one key, a global toggle, every command shown in full the way pi
 * shows them. No cursor, no per-entry selection — and the whole D4
 * problem ("I cannot tell the entries apart") evaporates, because
 * nothing has to be told apart when everything is on screen.
 *
 * Also recorded, because the owner asked and the answer is not
 * flattering: ctrl+o came from the reference implementation's own
 * documentation, relayed by a research agent. I never verified it in a
 * running instance, and the owner has never seen it. It is replaced
 * here by the key kiso already teaches.
 *
 * The one constraint that shapes it: committed rows cannot be rewritten
 * (ADR-0046). pi expands in place because it owns the document and
 * erases the terminal's scrollback when it shrinks. kiso's expansion
 * therefore paints in the OVERLAY — the zero-litter live-region takeover
 * the keys sheet already ships — in pi's block style.
 *
 *   node scripts/tui-v14-expandall-preview.mjs              # all four
 *   node scripts/tui-v14-expandall-preview.mjs --frame 2    # ONE frame
 *   node scripts/tui-v14-expandall-preview.mjs --dark       # dark ground
 *   node scripts/tui-v14-expandall-preview.mjs [--plain] [--check]
 */
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const PLAIN = argv.includes("--plain") || process.env.NO_COLOR !== undefined;
const wIdx = argv.indexOf("--width");
const W = Math.max(52, Math.min(110, wIdx >= 0 ? Number(argv[wIdx + 1]) : (process.stdout.columns || 84)));
// The slab's ground. kiso's own `wash` token is resolved per ground
// (DC-3's ladder) precisely because a hardcoded background is invisible
// on half the terminals — which this preview then did anyway, dark-on-
// dark, on the owner's light terminal. Default LIGHT; --dark for a dark
// ground; NO_COLOR drops it entirely and the rows still read.
const DARK = argv.includes("--dark");
const A = { b: "1", d: "2", rv: "7", sh: DARK ? "48;5;236" : "48;5;254" };
const w = (r) => (t) => (PLAIN ? t : `\x1b[${A[r]}m${t}\x1b[0m`);
const b = w("b"), d = w("d"), rv = w("rv");
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const fit = (row) => { if (vis(row) <= W) return row; let o="",n=0;
  for (let i=0;i<row.length;){ if(row[i]==="\x1b"){const j=row.indexOf("m",i);o+=row.slice(i,j+1);i=j+1;continue;} if(n>=W-1)break; o+=row[i];n++;i++; } return `${o}…\x1b[0m`; };
/** pi's shape: a shaded slab, padded to the full width so it reads as one object. */
const slab = (t) => PLAIN ? t : `\x1b[${A.sh}m${t}${" ".repeat(Math.max(0, W - vis(t)))}\x1b[0m`;
const FRAMES = [];
const frame = (t, n, rows) => FRAMES.push({ t, n, rows: rows.map(fit) });
const fIdx = argv.indexOf("--frame");
const ONLY = fIdx >= 0 ? Number(argv[fIdx + 1]) : null;
const chip = rv(` why is the CI job failing `.padEnd(W));
const rule = () => d("─".repeat(W));

frame("1 · the stream — compact, as it is today",
 "Three stretches, folded to a line each. This is what you scroll past; it stays exactly this size.",
 [chip, "",
  d("  thought 4s · ran 1 shell command"),
  "The check passes clean. Reading the store layer next.", "",
  d("  thought 1s · read 2 files"),
  "store.ts derives the floor, never stores it.", "",
  d("  thought 9s · ran 2 shell commands"),
  "The rollup binary is an optional platform package.", "",
  rule(), d(" › "), rule(),
  `${d("✧")} ${d("working 41s · ctrl+r shows every command · ctx left ~88%")}`]);

frame("2 · ctrl+r — every command, in full, pi's shape",
 "One key. No cursor, nothing to choose. The blocks are shaded slabs: the command as typed, its output, what was cut, and how long it took. Scroll with ↑↓ / PgUp / PgDn.",
 [d(`── every command · 1-3 of 3 ${"─".repeat(Math.max(0, W - 28))}`),
  d("  step 1 · thought 4s"),
  slab("  $ npm run check"),
  slab("  tui-cells 94 passed"),
  slab("  tui 181 passed"),
  slab(d("  … 78 earlier lines")),
  slab(d("  exit 0 · took 12.4s")),
  "",
  d("  step 2 · read 2 files"),
  slab("  packages/tui/src/compositor.ts · 3120 lines"),
  slab("  packages/runtime/src/store.ts · 412 lines"),
  "",
  rule(),
  d(" ↑↓ PgUp PgDn scroll · ctrl+r closes")]);

frame("3 · scrolled down — the last step, and its thinking",
 "The thinking is here too, in the same shape: it is what the model was doing, and it was as unreachable as the commands.",
 [d(`── every command · 2-3 of 3 ${"─".repeat(Math.max(0, W - 28))}`),
  d("  step 3 · thought 9s"),
  slab(d("  the failing job pulls the rollup native binary in the")),
  slab(d("  CI-only verify step, where the lockfile's optional")),
  slab(d("  platform package is never installed on a clean runner")),
  slab("  $ gh run view 33295178685 --log-failed | head -80"),
  slab("  Error: Cannot find module @rollup/rollup-linux-x64-gnu"),
  slab(d("  … 41 earlier lines")),
  slab(d("  exit 0 · took 1.5s")),
  "",
  rule(),
  d(" ↑↓ PgUp PgDn scroll · ctrl+r closes")]);

frame("4 · ctrl+r again — closed, and the stream is untouched",
 "Byte for byte what frame 1 was. Nothing scrolled away, nothing was appended, and the run never paused.",
 [chip, "",
  d("  thought 4s · ran 1 shell command"),
  "The check passes clean. Reading the store layer next.", "",
  d("  thought 1s · read 2 files"),
  "store.ts derives the floor, never stores it.", "",
  d("  thought 9s · ran 2 shell commands"),
  "The rollup binary is an optional platform package.", "",
  rule(), d(" › "), rule(),
  `${d("✧")} ${d("working 43s · ctrl+r shows every command · ctx left ~88%")}`]);

if (CHECK) {
  const bad = [];
  for (const f of FRAMES) for (const r of f.rows) {
    if (vis(r) > W) bad.push(`${f.t}: row wider than W=${W}`);
    if (/[\n\r]/.test(r)) bad.push(`${f.t}: newline in a row`);
  }
  if (bad.length) { for (const x of bad) console.error(`FAIL  ${x}`); process.exit(1); }
  console.log(`[tui-v14] OK at W=${W} — ${FRAMES.length} frames, every row one row within W.`);
  process.exit(0);
}
const chosen = ONLY === null ? FRAMES : FRAMES.slice(ONLY - 1, ONLY);
if (chosen.length === 0) { console.error(`no frame ${ONLY} — there are ${FRAMES.length}`); process.exit(1); }
for (const f of chosen) {
  console.log(`\n${PLAIN ? f.t : b(f.t)}`);
  console.log(`${PLAIN ? f.n : d(f.n)}\n`);
  for (const r of f.rows) console.log(r);
}
