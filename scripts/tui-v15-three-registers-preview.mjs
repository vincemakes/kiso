#!/usr/bin/env node
/**
 * kiso TUI v15 — THREE REGISTERS: thinking, command, prose.
 *
 * The owner's proposal, and it dissolves more of this round than any of
 * my four designs did:
 *
 *   thinking  italic, dim, its own paragraph — ALWAYS VISIBLE, never folded
 *   command   a shaded slab — the only thing ctrl+r folds
 *   prose     plain, the ground's own colour
 *
 * Why it is better than what came before: every complaint in this round
 * was some form of "I cannot see what it was thinking / what it ran".
 * Folding thinking away was the cause; the fold machinery was then asked
 * to give it back through an ordinal, a cursor, a viewer, a look-back.
 * Stop folding the thinking and the question stops being asked. What is
 * actually bulky is command OUTPUT — 82 lines of `ls -la` — and that is
 * the one thing left for a key to collapse.
 *
 *   node scripts/tui-v15-three-registers-preview.mjs [--frame N] [--dark] [--plain] [--check]
 */
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });
const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const PLAIN = argv.includes("--plain") || process.env.NO_COLOR !== undefined;
const DARK = argv.includes("--dark");
const wIdx = argv.indexOf("--width");
const W = Math.max(52, Math.min(110, wIdx >= 0 ? Number(argv[wIdx + 1]) : (process.stdout.columns || 84)));
const SH = DARK ? "48;5;236" : "48;5;254";
const esc = (c, t) => (PLAIN ? t : `\x1b[${c}m${t}\x1b[0m`);
const b = (t) => esc("1", t), d = (t) => esc("2", t), rv = (t) => esc("7", t);
/** MD-1 gave the palette SGR 3 with its own close, exactly so a register
 *  could be marked without spending a colour. This is that member's
 *  second use. */
const it = (t) => (PLAIN ? t : `\x1b[2;3m${t}\x1b[23m\x1b[0m`);
const vis = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const fit = (r) => { if (vis(r) <= W) return r; let o="",n=0;
  for (let i=0;i<r.length;){ if(r[i]==="\x1b"){const j=r.indexOf("m",i);o+=r.slice(i,j+1);i=j+1;continue;} if(n>=W-1)break; o+=r[i];n++;i++; } return `${o}…\x1b[0m`; };
const slab = (t) => PLAIN ? t : `\x1b[${SH}m${t}${" ".repeat(Math.max(0, W - vis(t)))}\x1b[0m`;
const FRAMES = [];
const frame = (t, n, rows) => FRAMES.push({ t, n, rows: rows.map(fit) });
const fIdx = argv.indexOf("--frame");
const ONLY = fIdx >= 0 ? Number(argv[fIdx + 1]) : null;
const chip = rv(` \u5e2e\u6211\u67e5\u770b\u4e0b\u5f53\u524d\u7684\u9879\u76ee\u5427 `.padEnd(W - 8));

frame("1 · the three registers, as they stream",
 "Thinking is italic and dim and stands on its own — you never have to ask for it. Prose is the ground's own colour. The command is a slab, and it is the only thing a key will fold.",
 [chip, "",
  it("  The user wants me to look at the current project. Let me"),
  it("  check the current working directory to see what's there."), "",
  "\u597d\u7684,\u8ba9\u6211\u5148\u770b\u770b\u5f53\u524d\u76ee\u5f55\u7684\u5185\u5bb9\u3002", "",
  slab("  $ pwd && ls -la"),
  slab(""),
  slab(d("  … 82 earlier lines · ctrl+r folds every block")),
  slab("  drwxr-xr-x+  4 vinve staff  128  9\u6708 10  2024 Public"),
  slab("  drwxr-xr-x@ 12 vinve staff  384  6\u6708 24 13:35 uooki_workspace"),
  slab(""),
  slab(d("  took 0.0s")), "",
  it("  The current directory is the home directory /Users/vinve,"),
  it("  not a specific project. Let me check the package.json."), ""]);

frame("2 · ctrl+r — every command SLAB collapses to one line",
 "Only the slabs move. The thinking stays exactly where it was, because it was never folded — that is the whole point of the proposal.",
 [chip, "",
  it("  The user wants me to look at the current project. Let me"),
  it("  check the current working directory to see what's there."), "",
  "\u597d\u7684,\u8ba9\u6211\u5148\u770b\u770b\u5f53\u524d\u76ee\u5f55\u7684\u5185\u5bb9\u3002", "",
  slab(`  $ pwd && ls -la${d("  · 86 lines · exit 0 · 0.0s")}`), "",
  it("  The current directory is the home directory /Users/vinve,"),
  it("  not a specific project. Let me check the package.json."), "",
  slab(`  $ cat package.json${d("  · 5 lines · exit 0 · 0.0s")}`), "",
  "\u5f53\u524d\u76ee\u5f55\u662f\u4f60\u7684\u7528\u6237\u4e3b\u76ee\u5f55,\u4e0d\u662f\u4e00\u4e2a\u5177\u4f53\u7684\u9879\u76ee\u76ee\u5f55\u3002", ""]);

frame("3 · what a long think does — the one real risk",
 "A model that thinks for two thousand words would wall the screen in italic. The cap is the answer the product already uses everywhere else: show the head, name what was cut, and let the same key open it.",
 [chip, "",
  it("  The failing job pulls the rollup native binary in the CI-only"),
  it("  verify step. The lockfile has the entry but a clean Linux"),
  it("  runner never installs the optional platform package, which is"),
  it("  npm's own long-standing optional-dependency bug — so build and"),
  it("  typecheck pass and only vitest dies."),
  d("  … 38 more lines of thinking · ctrl+r"), "",
  "\u6839\u56e0\u786e\u8ba4\u4e86:rollup \u7684\u5e73\u53f0\u5305\u5728\u5e72\u51c0 Linux \u4e0a\u6ca1\u88c5\u4e0a\u3002", ""]);

frame("4 · the register table",
 "Three registers, three jobs. No mark is needed to tell them apart — the FORM does it, and the form survives a pipe as bytes.",
 [d("  register   how it reads              folds?   why"),
  d("  ────────   ───────────────────────   ──────   ─────────────────"),
  `  ${it("thinking")}   ${d("italic, dim, own block")}    ${d("no")}       ${d("it is why the")}`,
  d("                                              answer is what it is"),
  `  ${slab("command")}    ${d("a slab, gutterless")}        ${d("YES")}      ${d("output is the bulk")}`,
  `  prose      ${d("the ground's own colour")}   ${d("no")}       ${d("it IS the answer")}`,
  "",
  d("  ctrl+r folds and unfolds every slab. Nothing else moves."),
  d("  No ordinal, no cursor, no viewer, no mode.")]);

if (CHECK) {
  const bad = [];
  for (const f of FRAMES) for (const r of f.rows) {
    if (vis(r) > W) bad.push(`${f.t}: row wider than W=${W} (${vis(r)})`);
    if (/[\n\r]/.test(r)) bad.push(`${f.t}: newline in a row`);
  }
  if (bad.length) { for (const x of bad) console.error(`FAIL  ${x}`); process.exit(1); }
  console.log(`[tui-v15] OK at W=${W} — ${FRAMES.length} frames, every row one row within W.`);
  process.exit(0);
}
const chosen = ONLY === null ? FRAMES : FRAMES.slice(ONLY - 1, ONLY);
for (const f of chosen) {
  console.log(`\n${PLAIN ? f.t : b(f.t)}`);
  console.log(`${PLAIN ? f.n : d(f.n)}\n`);
  for (const r of f.rows) console.log(r);
}
