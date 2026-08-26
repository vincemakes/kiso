/**
 * REL-0152-D12 — the byte trace: what kiso actually sent, and when.
 *
 * Three defects in this round are only decidable from the byte stream:
 *
 *   - REL-0152-D1, the stray `[` and `]` at the row edges. `[` is the
 *     CSI introducer and `]` the OSC introducer, so a lost ESC prints
 *     exactly those two characters and nothing else — but kiso emits no
 *     OSC at all, and every CSI it writes carries more than its
 *     introducer. Either the bytes leaving kiso already contain those
 *     characters (ours) or they do not (the terminal's parser). Nobody
 *     can tell from a screenshot, and three rounds have now tried.
 *   - REL-0152-D7, content that appears late or not at all. The frame
 *     that should have carried it either went out or did not.
 *   - the paste latency. The editor is measured at 146KB in 6ms, so if
 *     a paste still feels slow the time is being spent before kiso sees
 *     the bytes — which the arrival timestamps show directly.
 *
 * Set KISO_TRACE_BYTES to a path and every byte in BOTH directions is
 * recorded with a millisecond stamp, then the file answers the question
 * instead of another round of inference.
 *
 *   KISO_TRACE_BYTES=/tmp/kiso-bytes.jsonl kiso chat
 *
 * One JSON object per line: {ms, dir, n, b} — the stamp relative to the
 * trace's start, "out"/"err"/"in", the byte count, and the bytes as base64
 * so no escape, control character or partial UTF-8 sequence is altered
 * on the way to disk. Nothing is interpreted here; interpretation is
 * what the trace exists to make possible.
 *
 * OFF unless the variable is set: zero cost, and it never turns itself
 * on. What it records is the terminal traffic of one session — screen
 * output and keystrokes — so it is a diagnostic a person switches on
 * deliberately, for one run, when something is wrong.
 */

import { appendFileSync, writeFileSync } from "node:fs";

let path: string | null = null;
let start = 0;

function line(dir: "out" | "err" | "in", data: string | Uint8Array): void {
	if (path === null) return;
	const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
	try {
		appendFileSync(path, `${JSON.stringify({ ms: Date.now() - start, dir, n: buf.length, b: buf.toString("base64") })}\n`);
	} catch {
		// a trace that fails must never take the session with it
		path = null;
	}
}

/**
 * Arm the trace if KISO_TRACE_BYTES names a file. Call once, before the
 * dock is entered, so the first frame is in the record too.
 *
 * stdout is wrapped rather than tapped because there is no other way to
 * see every write: the compositor, the CLI's own logging and node's
 * error paths all reach the terminal through it. stdin is TAPPED — an
 * extra "data" listener, which every listener receives — so the editor's
 * own reading is untouched and the trace cannot swallow a keystroke.
 */
export function armByteTrace(): void {
	const target = process.env.KISO_TRACE_BYTES;
	if (target === undefined || target === "") return;
	path = target;
	start = Date.now();
	try {
		writeFileSync(path, "");
	} catch {
		path = null;
		return;
	}
	// REL-0152-D17: BOTH descriptors. The first version traced stdout
	// alone, and kiso's degradation notices go to stderr — so a capture
	// taken to prove "the bytes leaving kiso are clean" could not see the
	// bytes that were not clean. It supported that conclusion by being
	// blind to the counter-evidence, which is the worst thing an
	// instrument can do. `dir` distinguishes them so a reader can tell
	// which descriptor carried what, and interleave them by timestamp.
	for (const [dir, stream] of [["out", process.stdout] as const, ["err", process.stderr] as const]) {
		const write = stream.write.bind(stream);
		stream.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
			line(dir, chunk);
			return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
		}) as typeof stream.write;
	}
	process.stdin.on("data", (chunk: Buffer) => line("in", chunk));
	// The environment goes in the record FIRST, because kiso emits
	// DIFFERENT frame bytes per terminal — DEC 2026 synchronized output
	// where it is supported, a cursor-hide degrade on Apple Terminal —
	// so a capture that does not say which terminal made it cannot be
	// compared against anything. Same for the size and the locale: a row
	// is built to a width, and the ambiguous-width characters kiso uses
	// in its own chrome (· … —) are one cell or two depending on how the
	// terminal was told to treat them.
	const env = {
		TERM_PROGRAM: process.env.TERM_PROGRAM ?? null,
		TERM_PROGRAM_VERSION: process.env.TERM_PROGRAM_VERSION ?? null,
		TERM: process.env.TERM ?? null,
		LANG: process.env.LANG ?? null,
		LC_CTYPE: process.env.LC_CTYPE ?? null,
		columns: process.stdout.columns ?? null,
		rows: process.stdout.rows ?? null,
	};
	try {
		appendFileSync(path, `${JSON.stringify({ ms: 0, dir: "env", n: 0, b: "", env })}\n`);
	} catch {
		path = null;
	}
}
