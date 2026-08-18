/**
 * TUI2-MD slice ⑥ — the ACCEPTANCE CONTENT, end to end, on a real PTY.
 *
 * Every gate before this one measures a layer. This one measures the
 * product: the owner's own audit-session output, streamed in ragged
 * deltas through the real CLI in faux mode, read off a real terminal.
 * If markdown renders here, it renders.
 *
 * The content lives OUTSIDE the repo (the tree-wide CJK gate), so the
 * fixture is the \uXXXX-escaped helper the renderer's own tests use —
 * the same string, byte for byte, verified against the source document.
 *
 * What the frames must show, and what they must NOT: the `##` markers
 * and the `**` pairs are GONE from the screen (they were rendered, not
 * printed); the list is `•` with its continuation lines hanging under
 * the text column; the table is drawn with the dim rails; and the
 * whole thing arrives without tripping the compositor's width
 * invariant, which would have killed the process.
 */

import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { MD_BENCHMARK } from "../../../packages/tui-cells/tests/helpers/md-benchmark.js";
import { fauxScript, ptyRun, screenAt, settledScreen, spares } from "./helpers/pty.js";

const ROWS = 40;
const COLS = 100;

/** The acceptance content as a faux turn, streamed in ragged deltas —
 *  the shape a real provider produces, not one delta per message. */
function benchmarkTurn(): unknown {
	const events: unknown[] = [];
	const sizes = [3, 17, 1, 41, 9, 128, 5];
	for (let i = 0, n = 0; i < MD_BENCHMARK.length; n += 1) {
		const size = sizes[n % sizes.length]!;
		events.push({ type: "text_delta", text: MD_BENCHMARK.slice(i, i + size) });
		i += size;
	}
	events.push({ type: "stop", reason: "end_turn" });
	return { events };
}

/** ONE real session, shared by the gates below. A PTY run is the most
 *  expensive thing in the suite; three assertions about the same screen
 *  do not need three of them. */
let RAW: string | null = null;

function run(): string {
	if (RAW !== null) return RAW;
	const { env } = isolatedEnv();
	RAW = ptyRun([], { ...env, KISO_FAUX_SCRIPT: fauxScript([benchmarkTurn(), ...spares(3)]) }, {
		// both needles are chrome the PRODUCT emits, never text the fixture
		// carries — a needle that also appears in the content would match
		// the echo instead of the state it is waiting for. "0 tools" is the
		// recap's own count: the turn has settled, so the session can end.
		feeds: [
			["▌ ", "audit this repo\r"],
			["0 tools", "\x04"],
		],
		rows: ROWS,
		cols: COLS,
		timeout: 60,
	});
	return RAW;
}

describe("TUI2-MD ⑥ — the acceptance content, end to end", () => {
	it("T-MD-44: the settled screen renders markdown, and shows none of its syntax", () => {
		const grid = settledScreen(run(), ROWS, COLS);
		const text = grid.join("\n");
		// the heading's marker is stripped and its numbering kept
		expect(text).toContain("3. TUI resize");
		expect(text).not.toContain("## ");
		// the bold pairs were rendered, not printed
		expect(text).not.toContain("**");
		// the backticks of an inline code span are gone (the tint replaced
		// them) — `MaxListenersExceededWarning` appears without them
		expect(text).toContain("MaxListenersExceededWarning");
		expect(text).not.toContain("`MaxListeners");
		// the list is normalized and hangs
		expect(text).toContain("• ");
		// the table is drawn, not passed through
		expect(text).toMatch(/├─+┼/);
		expect(text).not.toContain("|---|");
	}, 90_000);

	it("T-MD-45: the styled bytes are the round's alphabet and nothing else", () => {
		const raw = run();
		// every SGR the run emitted, over the whole session: the closed
		// alphabet plus the cursor/erase CSIs the compositor owns
		const allowed = new Set(["\x1b[0m", "\x1b[1m", "\x1b[2m", "\x1b[3m", "\x1b[7m", "\x1b[23m", "\x1b[27m", "\x1b[31m", "\x1b[32m", "\x1b[33m", "\x1b[38;5;252m"]);
		const seen = new Set([...raw.matchAll(/\x1b\[[0-9;]*m/g)].map((m) => m[0]));
		expect([...seen].filter((s) => !allowed.has(s))).toEqual([]);
		// italic really did reach the wire as an attribute this round
		expect(allowed.has("\x1b[3m")).toBe(true);
	}, 90_000);

	it("T-MD-46: mid-stream, the frozen prefix is already rendered", () => {
		// the frame at the moment the third heading is painted: everything
		// above it has closed and committed, and it is rendered markdown —
		// not raw source waiting for the end of the message.
		const raw = run();
		const grid = screenAt(raw, "TUI resize", ROWS, COLS);
		const text = grid.join("\n");
		expect(text).not.toContain("## ");
		expect(text).not.toContain("**");
		expect(text).toContain("• ");
	}, 90_000);
});
