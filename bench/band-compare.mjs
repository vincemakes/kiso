#!/usr/bin/env node
/**
 * E4-d — the machine band verdict (band-compare.mjs).
 *
 * The verdict a release report previously hand-assembled, now produced
 * mechanically so the report embeds the machine's words verbatim:
 *
 *   node band-compare.mjs <prev.json> <this.json>  →  one JSON verdict
 *
 * The inputs are the extractors' own rows (the release's runs vs the
 * previous release's runs — the interleaved n=5). The rules, pinned:
 *   - the band is the PREVIOUS release's runs RANGE per metric
 *     (min..max — the band is the range, never the mean: the 0.1.46
 *     ruling); this release's runs sit in-band / out-below (the cheap
 *     side) / out-above (the expensive side);
 *   - verify is a gate: ANY failed verify → blocker-class, even on the
 *     cheap side;
 *   - the S1-1 directional clause applied mechanically: out-below with
 *     all verifies passing = improvement-class ("proposed, for the
 *     reviewer" + a numbered finding); out-above or any verify failure
 *     = blocker-class; mixed this-runs take the worst side;
 *   - the frontier point (the E4-c lens): verified passes (FAIL-first:
 *     a failed task contributes zero) vs costWeighted — this round's
 *     coordinates on the work-per-token trajectory, plus the ratio.
 */
import { readFileSync } from "node:fs";

const METRICS = ["costWeighted", "wall"];
const CLAUSE = "out-below + all verifies pass → improvement-class (proposed, for the reviewer)";

function band(rows, metric) {
  const vals = rows.map((r) => r[metric]).filter((v) => typeof v === "number");
  if (!vals.length) return null;
  return [Math.min(...vals), Math.max(...vals)];
}

function position(v, [lo, hi]) {
  if (v < lo) return "out-below";
  if (v > hi) return "out-above";
  return "in-band";
}

export function verdict(prev, thisRows) {
  const metrics = {};
  let anyOutAbove = false;
  let anyOutBelow = false;
  for (const m of METRICS) {
    const b = band(prev, m);
    if (b === null) continue;
    const positions = thisRows.map((r) => position(r[m], b));
    anyOutAbove ||= positions.some((p) => p === "out-above");
    anyOutBelow ||= positions.some((p) => p === "out-below");
    metrics[m] = { band: b, positions, thisValues: thisRows.map((r) => r[m]) };
  }

  const failures = thisRows.filter((r) => r.verify !== "pass").map((r) => r.run || r);
  const allPass = failures.length === 0;
  let klass = "in-band";
  if (!allPass || anyOutAbove) klass = "blocker-class";
  else if (anyOutBelow) klass = "improvement-class";

  // E4-c: the frontier point — verified work (FAIL-first: a failed task
  // counts zero, whatever its partial credit) vs costWeighted; the
  // work-per-token north star.
  const point = (rows) => {
    const verified = rows.reduce(
      (s, r) => s + (r.verify === "fail" ? 0 : (r.verifiedPass ?? (r.verify === "pass" ? 1 : 0))),
      0,
    );
    const cost = rows.reduce((s, r) => s + (r.costWeighted || 0), 0);
    return { verifiedPass: verified, costWeighted: cost };
  };
  const pPrev = point(prev);
  const pThis = point(thisRows);
  const frontier = {
    prev: pPrev,
    this: pThis,
    workPerToken: {
      prev: pPrev.costWeighted ? pPrev.verifiedPass / pPrev.costWeighted : null,
      this: pThis.costWeighted ? pThis.verifiedPass / pThis.costWeighted : null,
    },
  };

  return {
    class: klass,
    metrics,
    verify: { allPass, failures },
    clause: { directional: CLAUSE, source: "S1-1 (2026-08-12)" },
    frontier,
  };
}

function main() {
  const [prevPath, thisPath] = process.argv.slice(2);
  if (!prevPath || !thisPath) {
    process.stderr.write("usage: band-compare.mjs <prev.json> <this.json>\n");
    process.exit(1);
  }
  let prev, thisRows;
  try {
    prev = JSON.parse(readFileSync(prevPath, "utf8"));
    thisRows = JSON.parse(readFileSync(thisPath, "utf8"));
  } catch (err) {
    process.stderr.write(`band-compare: cannot read inputs: ${err.message}\n`);
    process.exit(1);
  }
  const rows = (x) => (Array.isArray(x) ? x : x.runs ?? []);
  process.stdout.write(JSON.stringify(verdict(rows(prev), rows(thisRows)), null, 1) + "\n");
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
