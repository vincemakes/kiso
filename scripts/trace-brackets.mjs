#!/usr/bin/env node
/**
 * REL-0152-D1 — read a KISO_TRACE_BYTES capture and answer one question:
 * did the stray `[` / `]` at the row edges leave kiso, or did the
 * terminal make them?
 *
 *   KISO_TRACE_BYTES=/tmp/kiso-bytes.jsonl kiso chat    # reproduce, exit
 *   node scripts/trace-brackets.mjs /tmp/kiso-bytes.jsonl
 *
 * The reported symptom is precise and this checks for exactly it: a `[`
 * in the first painted column of a row and a `]` in the last. kiso
 * prints plenty of legitimate brackets — the faux banner, the extension
 * list, the paste capsule — so counting brackets proves nothing. What
 * matters is whether one sits at a row EDGE.
 *
 * The stream is tokenized rather than stripped, so each text run keeps
 * the escape that positioned it. A bracket is an EDGE bracket when the
 * token before it moved the cursor to a row (CUP, CR, LF, or an erase
 * that follows one) or when the token after it does.
 *
 * Also reported, because it is the mechanism most likely to produce a
 * lone `[` from bytes that were correct when they left: a write that
 * ENDS mid-escape. A terminal whose escape parser times out at a chunk
 * boundary abandons the sequence and prints the rest as text, and an
 * abandoned CSI leaves behind exactly `[`.
 */

import { readFileSync } from "node:fs";

const file = process.argv[2];
if (file === undefined) {
	console.error("usage: node scripts/trace-brackets.mjs <trace.jsonl>");
	process.exit(2);
}

const rows = readFileSync(file, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const outs = rows.filter((r) => r.dir === "out");
const ins = rows.filter((r) => r.dir === "in");
const stream = Buffer.concat(outs.map((r) => Buffer.from(r.b, "base64"))).toString("latin1");

/** Tokenize into escapes and text runs, in order. */
const TOKEN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1bO.|\x1b[()#][0-9A-Za-z]|\x1b[=>78MDEHc]|\x1b/g;
const tokens = [];
let last = 0;
for (const m of stream.matchAll(TOKEN)) {
	if (m.index > last) tokens.push({ kind: "text", s: stream.slice(last, m.index) });
	tokens.push({ kind: "esc", s: m[0] });
	last = m.index + m[0].length;
}
if (last < stream.length) tokens.push({ kind: "text", s: stream.slice(last) });

const isMove = (s) => /^\x1b\[[0-9;]*[HGdABCD]$/.test(s) || /^\x1b\[[0-9]*[KJ]$/.test(s);
const startsRow = (i) => {
	for (let k = i - 1; k >= 0 && k >= i - 3; k -= 1) {
		const t = tokens[k];
		if (t.kind === "esc" && isMove(t.s)) return true;
		if (t.kind === "text" && /[\r\n]$/.test(t.s)) return true;
		if (t.kind === "text" && t.s !== "") return false;
	}
	return i === 0;
};
const endsRow = (i) => {
	for (let k = i + 1; k < tokens.length && k <= i + 3; k += 1) {
		const t = tokens[k];
		if (t.kind === "esc" && isMove(t.s)) return true;
		if (t.kind === "text" && /^[\r\n]/.test(t.s)) return true;
		if (t.kind === "text" && t.s !== "") return false;
	}
	return i === tokens.length - 1;
};

const edges = [];
for (let i = 0; i < tokens.length; i += 1) {
	const t = tokens[i];
	if (t.kind !== "text" || t.s === "") continue;
	const body = t.s.replace(/^[\r\n]+/, "");
	if (body.startsWith("[") && startsRow(i)) edges.push({ c: "[", where: "row start", ctx: JSON.stringify(body.slice(0, 50)) });
	if (/\]$/.test(t.s.replace(/[\r\n]+$/, "")) && endsRow(i)) edges.push({ c: "]", where: "row end", ctx: JSON.stringify(t.s.slice(-50)) });
}

const split = [];
for (const r of outs) {
	const tail = Buffer.from(r.b, "base64").toString("latin1").slice(-16);
	const cut = /\x1b\[?[0-9;?]*$/.exec(tail);
	if (cut !== null && cut[0] !== "") split.push({ ms: r.ms, tail: JSON.stringify(tail) });
}
const danglingEsc = tokens.filter((t) => t.kind === "esc" && t.s === "\x1b").length;

console.log(`trace: ${rows.length} records — ${outs.length} writes (${stream.length} bytes out), ${ins.length} reads`);
console.log(`\nEDGE brackets in kiso's own output: ${edges.length}`);
for (const e of edges.slice(0, 30)) console.log(`  ${e.c} at ${e.where}: ${e.ctx}`);
if (edges.length > 30) console.log(`  … ${edges.length - 30} more`);
console.log(`\nbare ESC with no sequence: ${danglingEsc}`);
console.log(`writes ENDING mid-escape (the split-sequence mechanism): ${split.length}`);
for (const s of split.slice(0, 10)) console.log(`  +${s.ms}ms tail=${s.tail}`);

// kiso prints several LEGITIMATE bracketed rows — the faux-mode banner,
// the extension list, the paste capsule — and they are edge brackets by
// construction. The tool lists what it found with enough context to tell
// them apart; it does not pretend to know which row the reader meant. The
// one verdict it will give on its own is about the MECHANISM, because
// that one is unambiguous.
const KNOWN = /^\[(byte trace armed|faux mode|\d+ extensions?|Pasted text #|Image #)/;
const unexplained = edges.filter((e) => e.c === "[" && !KNOWN.test(JSON.parse(e.ctx)));
console.log(`\nof those, [ starting a row that is NOT a known bracketed message: ${unexplained.length}`);
for (const e of unexplained.slice(0, 20)) console.log(`  ${e.ctx}`);
console.log(
	`\nmechanism: ${
		split.length > 0 || danglingEsc > 0
			? "sequences leave kiso SPLIT or incomplete — a terminal whose escape parser gives up at a chunk boundary prints the remainder, and an abandoned CSI leaves exactly `[`. Emit each frame as one write."
			: "every sequence leaves kiso whole, in one write. Nothing here can become a stray `[` on the way out."
	}`,
);
