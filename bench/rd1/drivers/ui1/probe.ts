/**
 * UI-1 probe — turns a captured session into verdicts.
 *
 * Deliberately separate from drive.py: a driver that also judges is a
 * driver that can talk itself into a pass. This reads only the bytes and
 * the phase marks.
 *
 * Four probes, and an explicit statement of what each one CANNOT see:
 *
 *   A  the scrollback is append-only. Once a row has scrolled off, it
 *      never changes. That is the standing block's entire claim, so it
 *      covers walkthrough items 1, 2, 5, 6 and 8 at once.
 *      Scope: stops at the first NARROWING — Screen models a widen only
 *      (DC-34 rider 2), and a gate built on a fictional terminal measures
 *      fiction.
 *   B  invariant (1): no emitted run ever reaches past the terminal's
 *      right edge. Runs over the WHOLE capture, narrow included.
 *   C  the ink clause: no 3J, no alt-screen, ever; and the transcript
 *      viewer commits nothing while it is up.
 *   D  the parallel burst puts all four names on one screen.
 *
 * usage: tsx probe.ts <out-dir>
 */
import { readFileSync } from "node:fs";
import { Screen } from "../../../../packages/tui/tests/helpers/screen.ts";
import { visibleWidth } from "../../../../packages/tui-cells/src/width.ts";

const ESC = String.fromCharCode(27);
const FRAME_END = `${ESC}[?2026l`;
const ERASE_SCROLLBACK = `${ESC}[3J`;
const ALT_SCREEN = `${ESC}[?1049h`;

type Mark = { at: number; name: string; t: number; cols?: number; n?: number; why?: string };

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: probe.ts <out-dir>");
const raw = readFileSync(`${dir}/ui1.raw`).toString("utf8");
const meta = JSON.parse(readFileSync(`${dir}/ui1.marks.json`, "utf8")) as {
	cols: number;
	rows: number;
	marks: Mark[];
};

/** Marks are byte offsets; the capture is decoded UTF-8. Re-derive each
 *  mark's CHARACTER offset so slicing lines up on multibyte output. */
const bytes = readFileSync(`${dir}/ui1.raw`);
const charAt = (byteOff: number): number => bytes.subarray(0, byteOff).toString("utf8").length;
const marks = meta.marks.map((m) => ({ ...m, ch: charAt(m.at) }));
const markNamed = (name: string) => marks.find((m) => m.name === name);

const results: { probe: string; ok: boolean; note: string }[] = [];
const add = (probe: string, ok: boolean, note: string) => results.push({ probe, ok, note });

// ---------------------------------------------------------------- widths
/** The terminal width in force at each character offset. */
const widthChanges = marks
	.filter((m) => m.cols !== undefined)
	.map((m) => ({ ch: m.ch, cols: m.cols! }));
const widthAt = (ch: number): number => {
	let w = meta.cols;
	for (const c of widthChanges) if (c.ch <= ch) w = c.cols;
	return w;
};
const firstNarrow = ((): number | null => {
	let prev = meta.cols;
	for (const c of widthChanges) {
		if (c.cols < prev) return c.ch;
		prev = c.cols;
	}
	return null;
})();

// ------------------------------------------- probe A: append-only history
{
	const stop = firstNarrow ?? raw.length;
	const upto = raw.slice(0, stop);
	const screen = new Screen(meta.cols, meta.rows);
	// split on the synchronized-update close: a frame is atomic, so it is
	// the only safe place to cut the stream without splitting an escape.
	const frames: string[] = [];
	let cursor = 0;
	for (;;) {
		const k = upto.indexOf(FRAME_END, cursor);
		if (k < 0) {
			if (cursor < upto.length) frames.push(upto.slice(cursor));
			break;
		}
		frames.push(upto.slice(cursor, k + FRAME_END.length));
		cursor = k + FRAME_END.length;
	}
	let prev: string[] = [];
	let at = 0;
	const violations: string[] = [];
	let historyHigh = 0;
	for (const f of frames) {
		const end = at + f.length;
		const w = widthAt(end);
		if (w > screen.W) screen.resizeTo(w);
		screen.feed(f);
		const hist = screen.history.map((r) => r.join(""));
		if (hist.length < prev.length) {
			violations.push(`history SHRANK ${prev.length} -> ${hist.length} @${at}`);
		} else {
			for (let i = 0; i < prev.length; i += 1) {
				// a widen pads every row on the right; compare on content
				if (hist[i]!.trimEnd() !== prev[i]!.trimEnd()) {
					violations.push(`row ${i} REWRITTEN @${at}\n      was: ${JSON.stringify(prev[i]!.trimEnd())}\n      now: ${JSON.stringify(hist[i]!.trimEnd())}`);
					break;
				}
			}
		}
		prev = hist;
		historyHigh = Math.max(historyHigh, hist.length);
		at = end;
	}
	const scope = firstNarrow === null ? "whole capture" : `up to the first narrowing (char ${firstNarrow})`;
	add(
		"A  scrollback is append-only (items 1,2,5,6,8)",
		violations.length === 0,
		violations.length === 0
			? `${frames.length} frames, ${historyHigh} rows committed, ${scope}`
			: `${violations.length} violation(s), ${scope}\n    ${violations.slice(0, 3).join("\n    ")}`,
	);
}

// ------------------------------------------------- probe B: invariant (1)
{
	// Walk the stream tracking the cursor COLUMN, and check every printable
	// run against the width in force. Frames run with autowrap off and every
	// row is cursor-addressed, so a run that reaches past the edge is a row
	// the terminal will silently drop the tail of.
	//
	// THE GRACE. A narrowing is delivered by SIGWINCH, which kiso cannot
	// observe before the ioctl returns. Frames already in flight were
	// composed for the OLD width and overrun the new one by construction —
	// that is physics, not a defect, and a probe that scored it would be
	// scoring the driver's own ioctl. So frames that begin within
	// GRACE_FRAMES of a narrowing are EXCLUDED, and the count is reported
	// rather than hidden: an excluded frame is a frame not judged.
	const GRACE_FRAMES = 3;

	// frame boundaries over the whole capture
	const bounds: { start: number; end: number }[] = [];
	let cur = 0;
	for (;;) {
		const k = raw.indexOf(FRAME_END, cur);
		if (k < 0) {
			if (cur < raw.length) bounds.push({ start: cur, end: raw.length });
			break;
		}
		bounds.push({ start: cur, end: k + FRAME_END.length });
		cur = k + FRAME_END.length;
	}
	const narrowings: number[] = [];
	{
		let prev = meta.cols;
		for (const c of widthChanges) {
			if (c.cols < prev) narrowings.push(c.ch);
			prev = c.cols;
		}
	}
	const excused = new Set<number>();
	for (const n of narrowings) {
		const first = bounds.findIndex((b) => b.end > n);
		if (first < 0) continue;
		for (let i = first; i < Math.min(bounds.length, first + GRACE_FRAMES); i += 1) excused.add(i);
	}

	let col = 1;
	let run = "";
	let runStart = 0;
	let judged = 0;
	const over: string[] = [];
	const scan = (text: string, base: number, w: number, judge: boolean) => {
		const flush = (endCh: number) => {
			if (run === "") return;
			const reach = col - 1 + visibleWidth(run);
			if (judge && reach > w) {
				over.push(`reach ${reach} > W ${w} @${runStart}: ${JSON.stringify(run.slice(0, 60))}`);
			}
			col += visibleWidth(run);
			run = "";
			void endCh;
		};
		for (let i = 0; i < text.length; i += 1) {
			const c = text[i]!;
			if (c === ESC) {
				flush(base + i);
				const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(text.slice(i, i + 24));
				if (m === null) {
					const osc = /^\x1b\][^\x07]*\x07/.exec(text.slice(i, i + 64));
					i += (osc?.[0].length ?? 1) - 1;
					continue;
				}
				const params = m[1]!.split(";");
				const fin = m[2]!;
				if (fin === "H" || fin === "f") col = Number(params[1] ?? "1") || 1;
				else if (fin === "G") col = Number(params[0] ?? "1") || 1;
				else if (fin === "C") col += Number(params[0] ?? "1") || 1;
				else if (fin === "D") col = Math.max(1, col - (Number(params[0] ?? "1") || 1));
				i += m[0].length - 1;
				continue;
			}
			if (c === "\r") {
				flush(base + i);
				col = 1;
				continue;
			}
			if (c === "\n") {
				flush(base + i);
				continue;
			}
			if (run === "") runStart = base + i;
			run += c;
		}
		flush(base + text.length);
	};
	for (let i = 0; i < bounds.length; i += 1) {
		const b = bounds[i]!;
		const judge = !excused.has(i);
		if (judge) judged += 1;
		scan(raw.slice(b.start, b.end), b.start, widthAt(b.end), judge);
	}
	add(
		"B  no row reaches past the right edge (item 9, invariant 1)",
		over.length === 0,
		over.length === 0
			? `every run fits in ${judged} judged frames (${excused.size} excused as post-SIGWINCH in-flight)`
			: `${over.length} overrun(s) in ${judged} judged frames\n    ${over.slice(0, 3).join("\n    ")}`,
	);
}

// ---------------------------------------------------- probe C: the ink clause
{
	const notes: string[] = [];
	let ok = true;
	if (raw.includes(ERASE_SCROLLBACK)) {
		ok = false;
		notes.push("the terminal's scrollback was ERASED (3J)");
	}
	if (raw.includes(ALT_SCREEN)) {
		ok = false;
		notes.push("the alternate screen was entered");
	}
	const open = markNamed("item6.open");
	const closed = markNamed("item6.closed");
	if (open !== undefined && closed !== undefined) {
		// count committed rows on each side by replaying twice
		const commitsBy = (stop: number): number => {
			const s = new Screen(meta.cols, meta.rows);
			s.feed(raw.slice(0, stop));
			return s.history.length;
		};
		const before = commitsBy(open.ch);
		const after = commitsBy(closed.ch);
		if (after !== before) {
			ok = false;
			notes.push(`the viewer committed ${after - before} row(s) while it was up`);
		} else {
			notes.push(`the viewer committed nothing while up (${before} rows either side)`);
		}
	} else {
		notes.push("item 6 marks missing - viewer leg not driven");
	}
	add("C  the ink clause holds (item 6)", ok, notes.join("; "));
}

// ------------------------------------------------- probe D: parallel burst
{
	const begin = markNamed("item5.begin");
	const end = markNamed("item5.end");
	if (begin === undefined || end === undefined) {
		add("D  the parallel burst shows all four names (item 5)", false, "item 5 marks missing");
	} else {
		const s = new Screen(meta.cols, meta.rows);
		s.feed(raw.slice(0, end.ch));
		const all = s.allLines().slice(-meta.rows - 40).join("\n");
		const want = ["alpha.py", "beta.py", "gamma.py", "delta.py"];
		const missing = want.filter((f) => !all.includes(f));
		add(
			"D  the parallel burst shows all four names (item 5)",
			missing.length === 0,
			missing.length === 0 ? "all four on screen" : `missing: ${missing.join(", ")}`,
		);
	}
}

// --------------------------------------------------------------- report
let bad = 0;
for (const r of results) {
	console.log(`${r.ok ? "ok   " : "FAIL "}${r.probe}`);
	console.log(`       ${r.note.replace(/\n/g, "\n       ")}`);
	if (!r.ok) bad += 1;
}
const timeouts = marks.filter((m) => m.name === "TIMEOUT");
if (timeouts.length > 0) {
	console.log(`\nDRIVER TIMEOUTS (${timeouts.length}) — these weaken the run, they are not verdicts:`);
	for (const t of timeouts) console.log(`  ${t.why} @${t.at}`);
}
console.log(`\nUI1_PROBE_FAIL=${bad}`);
