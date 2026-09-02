/**
 * UI-1 look — render the screen as it stood at a named mark.
 *
 * The probes answer the mechanical questions. Three walkthrough items
 * (3's honesty about an interrupted call, 4's panel over the block, 7's
 * column alignment) are judgements about WORDS, and the only honest way
 * to put those to a reader is to show the screen, not to describe it.
 *
 * usage: tsx look.ts <out-dir> <mark-name> [tail-rows]
 */
import { readFileSync } from "node:fs";
import { Screen } from "../../../../packages/tui/tests/helpers/screen.ts";

type Mark = { at: number; name: string; t: number; cols?: number };

const [dir, want, tailArg] = process.argv.slice(2);
if (dir === undefined || want === undefined) throw new Error("usage: look.ts <out-dir> <mark> [tail-rows]");
const tail = Number(tailArg ?? "0");

const bytes = readFileSync(`${dir}/ui1.raw`);
const raw = bytes.toString("utf8");
const meta = JSON.parse(readFileSync(`${dir}/ui1.marks.json`, "utf8")) as { cols: number; rows: number; marks: Mark[] };
const charAt = (b: number): number => bytes.subarray(0, b).toString("utf8").length;

const mark = meta.marks.find((m) => m.name === want);
if (mark === undefined) {
	console.error(`no such mark. have: ${[...new Set(meta.marks.map((m) => m.name))].join(", ")}`);
	process.exit(1);
}
const stop = charAt(mark.at);

// replay to the mark, applying every WIDEN along the way (Screen models a
// widen only — a narrowing before the mark means this view cannot be built)
const s = new Screen(meta.cols, meta.rows);
let at = 0;
let w = meta.cols;
const steps = meta.marks.filter((m) => m.cols !== undefined && charAt(m.at) < stop).map((m) => ({ ch: charAt(m.at), cols: m.cols! }));
// The sentinel carries NO width: written as `{ ch: stop, cols: w }` it
// captured w at array-construction time (the ORIGINAL width) and so
// resized the grid back at the end, reporting a 100-wide screen for a
// 50-wide capture.
for (const step of [...steps, { ch: stop, cols: null as number | null }]) {
	s.feed(raw.slice(at, Math.min(step.ch, stop)));
	at = Math.min(step.ch, stop);
	if (step.cols !== null && step.cols > w) {
		s.resizeTo(step.cols);
		w = step.cols!;
	} else if (step.cols !== null && step.cols < w) {
		// Screen models a WIDEN only (DC-34 rider 2), so a narrowing cannot
		// be carried across. What CAN be modelled honestly is the terminal
		// a viewer has AFTER it: a fresh grid of the new width, fed from the
		// narrowing on. What that view cannot show is the pre-narrow content
		// — a real terminal reflows it, and this model does not claim to.
		console.error(`(fresh ${step.cols}-wide screen from the narrowing — earlier rows are the real terminal's to reflow)`);
		s.rows = Array.from({ length: meta.rows }, () => Array.from({ length: step.cols! }, () => " "));
		s.history = [];
		s.W = step.cols!;
		s.r = 0;
		s.c = 0;
		w = step.cols!;
	}
	if (at >= stop) break;
}

const rule = "─".repeat(Math.min(s.W, 120));
console.log(`# ${want}  t=${mark.t}s  W=${s.W}`);
console.log(rule);
if (tail > 0) for (const line of s.history.slice(-tail).map((r) => r.join(""))) console.log(line.replace(/\s+$/, ""));
if (tail > 0) console.log(`${"╌".repeat(Math.min(s.W, 120))}  (above: last ${tail} committed rows)`);
for (const line of s.rows.map((r) => r.join(""))) console.log(line.replace(/\s+$/, ""));
console.log(rule);
