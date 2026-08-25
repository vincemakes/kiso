/**
 * A7/D3/A8 (the v8 work order §A7) — the REPLAY harness: the reviewer's
 * 0.1.40 dogfood session's events (the fixture, generated from
 * ~/.kiso/sessions/2026-08-09T03-38.jsonl) feed the REAL compositor the
 * way the CLI feeds it, and a real-terminal cell model reconstructs the
 * screen FRAME BY FRAME — the terminal's kept state per frame, not just
 * the final screen (the run-0 answer scrolls away before the end; the
 * duplication is a FRAME-TIME phenomenon).
 *
 * The A7 finding: the long streaming answer duplicated in the
 * scrollback — the live->commit seam re-emitting (the V6-1 lesson: a
 * draw that does not cover every row leaves shifted copies). The gates:
 *  - every frame shows ONE copy of each answer (A7);
 *  - no blank-row pileups at the W11 boundary (A8);
 *  - the fold never overlaps the box chrome (D3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { renderRecap } from "../src/render.js";
import { A7_SESSION } from "./fixtures/a7-session.js";

import { Screen } from "./helpers/screen.js";


interface Frame {
	/** the frame ordinal (the event index at which the frame rendered) */
	n: number;
	evType: string;
	evSeq: number;
	bytes: string;
	/** the scrollback+visible counts — the honest duplication measure */
	am0: { blocks: number; rows: number };
	am1: { blocks: number; rows: number };
	m0: { blocks: number; rows: number };
	m1: { blocks: number; rows: number };
	maxBlankRun: number;
	lines: string[];
	all: string[];
}

/** The replay — the CLI's exact cell mapping over the session's events,
 *  one frame tick per event, the screen accumulated across frames. */
export function replay(W: number, H: number): { frames: Frame[]; writes: string[] } {
	const writes: string[] = [];
	const body = new Body({
		active: () => true,
		height: () => H,
		width: () => W,
		editCol: () => 1,
		write: (s) => writes.push(s),
	});
	body.enter();
	const screen = new Screen(W, H);
	const frames: Frame[] = [];
	let run = -1;
	let tools = 0;
	let edits = 0;
	const usage = { in: null as number | null, out: null as number | null, cache: null as number | null, known: false };
	for (const row of A7_SESSION) {
		if (row.run !== run) {
			run = row.run;
			body.thinkingEnd();
		}
		const ev = row.ev;
		switch (ev.type) {
			case "user_input":
				body.userLine(String(ev.content ?? ""));
				break;
			case "thinking":
				body.thinkingAppend(String(ev.text ?? ""));
				break;
			case "tool_call_end":
				tools += 1;
				if (ev.name === "edit_file") edits += 1;
				body.toolStart(String(ev.name ?? "?"), String(ev.callId ?? "?"), (ev.input as Record<string, unknown>) ?? {});
				break;
			case "tool_execution_started":
				body.toolRunning(String(ev.callId ?? "?"));
				break;
			case "tool_execution_succeeded":
				body.toolSucceeded(String(ev.callId ?? "?"));
				break;
			case "tool_execution_failed":
				body.toolFailed(String(ev.callId ?? "?"), String(ev.error ?? "?"));
				break;
			case "tool_result": {
				const text = String(ev.content ?? "");
				let reason: string | null = null;
				if ((ev.tags as string[] | undefined)?.includes("denied")) {
					const m = /^\[Permission denied\] (.*)$/.exec(text);
					if (m !== null) reason = m[1]!;
				}
				body.toolResult(String(ev.callId ?? "?"), { content: text, isError: Boolean(ev.isError), reason });
				break;
			}
			case "text_delta":
				body.textAppend(String(ev.text ?? ""));
				break;
			case "text_end":
				body.textEnd();
				break;
			case "usage":
				usage.in = typeof ev.inputTokens === "number" ? ev.inputTokens : null;
				usage.out = typeof ev.outputTokens === "number" ? ev.outputTokens : null;
				usage.cache = typeof ev.cacheRead === "number" ? ev.cacheRead : null;
				usage.known = Boolean(ev.known);
				break;
			case "uncertain_pending":
				body.notice(`⚠ ${String(ev.name ?? "?")} FAILED — the side effect may have applied. ${String(ev.error ?? "")}`);
				break;
			case "permission_requested":
				body.toolApproval(String(ev.callId ?? "?"), null);
				break;
			case "permission_decided":
				// A5: the verdict binds INTO the cell (the CLI's chat.ts
				// ships the same mapping) — no free-standing verdict cell
				body.toolVerdict(String(ev.callId ?? ""), ev.decision === "approved" ? "approved" : "denied", typeof ev.decidedBy === "string" ? ev.decidedBy : undefined, typeof ev.reason === "string" ? ev.reason : undefined);
				break;
			case "terminal":
				body.endTurn(0);
				body.raw(renderRecap({ seconds: 0, tools, edits, usage, ctxLeftPct: null, mode: "default" }).split("\n"));
				break;
			default:
				break; // stop, tool_call_start, tool_call_input_delta — no cell
		}
		vi.advanceTimersByTime(16);
		// the frame's bytes (if any) — feed the screen, record the state
		const frameWrites = writes.slice();
		writes.length = 0;
		screen.feed(frameWrites.join(""));
		frames.push({
			n: frames.length,
			evType: String(ev.type),
			evSeq: typeof ev.seq === "number" ? ev.seq : -1,
			bytes: frameWrites.join(""),
			am0: screen.countsAll(M0),
			am1: screen.countsAll(M1),
			m0: screen.counts(M0),
			m1: screen.counts(M1),
			maxBlankRun: screen.maxBlankRun(),
			lines: screen.lines(),
			all: screen.allLines(),
		});
	}
	body.thinkingEnd();
	vi.advanceTimersByTime(16);
	screen.feed(writes.join(""));
	return { frames, writes };
}

/** The answer markers — run 0's greeting, run 1's first answer segment.
 *  The CJK rides \u escapes (the tree's CJK-free gate counts code
 *  points, not runtime strings). */
const M0 = "\u7f16\u7801\u52a9\u624b"; // "\u7f16\u7801\u52a9\u624b" — run 0's greeting
const M1 = "\u627e\u5230\u4e86"; // "\u627e\u5230\u4e86" — run 1's first answer segment

describe("A7 — the replay of the reviewer's dogfood session", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
		Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
	});

	afterEach(() => {
		vi.useRealTimers();
		delete (process.stdout as { rows?: number }).rows;
		delete (process.stdout as { columns?: number }).columns;
		delete (process.stdout as { isTTY?: boolean }).isTTY;
	});

	it("A7 — one answer copy in the terminal at every frame (the seam never re-emits), across the size sweep", () => {
		// the marker counts live in the SCROLLBACK too (countsAll) — the
		// duplication the reviewer saw was the pre-frame live copy the
		// commit scroll carried into the scrollback while the repaint made
		// a second copy below. Every frame must hold ONE copy of each
		// answer — at W=40 (the reproduction width: the 0.1.40 peaks at
		// 109 frames × 40×24, 670 × 40×12) and 80×24.
		const sizes = [[40, 12], [40, 24], [80, 24]] as const;
		for (const [W, H] of sizes) {
			const { frames } = replay(W, H);
			for (const f of frames) {
				expect(
					f.am0.blocks,
					`${W}x${H} frame ${f.n} (${f.evType}): run 0's greeting duplicated (A7)`,
				).toBeLessThanOrEqual(1);
				expect(
					f.am1.blocks,
					`${W}x${H} frame ${f.n} (${f.evType}): run 1's answer segment duplicated (A7)`,
				).toBeLessThanOrEqual(1);
			}
			// the markers DID reach the terminal — the gate is not vacuous
			expect(frames.some((f) => f.am0.rows > 0), `${W}x${H}: the M0 marker reached the terminal`).toBe(true);
			expect(frames.some((f) => f.am1.rows > 0), `${W}x${H}: the M1 marker reached the terminal`).toBe(true);
		}
	});

	it("A8 — the W11 boundary's blank never grows into a pileup band once the content fills the screen", () => {
		// the band's birth (frames 664-670 at 80×24): the bottom-anchored
		// window shifts the live region down on a done-fold with no
		// commits, the stale pass erases the old live rows, and the rows
		// between the committed window and the new liveTop are never
		// re-painted — a blank band that grows on each shrink and only
		// heals when the live region grows back. The gate: once the
		// content durably fills the window (nFill), no frame's longest
		// blank run exceeds 2 (the W11 blank + one transition row). The
		// pre-fix last band sat at 731 (40x24) / 725 (80x24) / 723
		// (40x12); post-fix (the shrink-only trigger, compositor.ts) the
		// fills land at 110 / 147 / 98 with NO post-fill band at any
		// size (measured −1 — the bound pins the fix).
		const sizes = [[40, 24, 600], [80, 24, 600], [40, 12, 700]] as const;
		for (const [W, H, bound] of sizes) {
			const { frames } = replay(W, H);
			let nFill = -1;
			for (let n = 0; n < frames.length; n += 1) {
				if (frames.slice(n).every((f) => f.maxBlankRun <= 2)) {
					nFill = n;
					break;
				}
			}
			expect(nFill, `${W}x${H}: the content durably fills the screen`).toBeGreaterThanOrEqual(0);
			expect(
				nFill,
				`${W}x${H}: the fill comes before the session's deep phase (the pre-fix last band sat at 731/725/723)`,
			).toBeLessThan(bound);
			for (let n = nFill; n < frames.length; n += 1) {
				const f = frames[n]!;
				expect(
					f.maxBlankRun,
					`${W}x${H} frame ${n} (${f.evType}): the W11-boundary pileup (A8)`,
				).toBeLessThanOrEqual(2);
			}
		}
	});

	it("A5 — the verdicts bind INTO the cells: no free-standing approval rows anywhere, the decidedBy rides the settled head row", () => {
		// the fixture's permission events (d-66: the human approved call_00;
		// d-67: mode:default approved call_01) previously rendered free-
		// standing `  approved` cells (the 0.1.40 orphan). A5 binds each
		// decision into its tool cell — the negative shape: NO line (visible
		// or scrollback) ever matches the orphan verdict form, at any size;
		// the positive shape: the extension-approved call's settled row
		// aggregates the decider (`· approved by mode:default`).
		const sizes = [[40, 12], [40, 24], [80, 24]] as const;
		for (const [W, H] of sizes) {
			const { frames } = replay(W, H);
			const orphan = /^ {0,2}(approved|denied)(: |$)/;
			for (const f of frames) {
				for (const line of f.all) {
					expect(line, `${W}x${H} frame ${f.n}: the free-standing verdict orphan (A5)`).not.toMatch(orphan);
				}
			}
			// MOVED (R1.5 slice ⑤, the approval-attribution class — DECLARED
			// THIS ROUND): `approved by mode:default` is gone from every
			// width. It was the runtime's backfill for "no policy expressed
			// an opinion", read by a human as an attribution, and this very
			// replay is where it appeared 36 cells wide on a 40-column row.
			// A policy verdict is ambient and silent; the row that names an
			// approval is the one a HUMAN answered. What the case still
			// pins — the verdict binds INTO the cell and never becomes a
			// free-standing row — is asserted above and unchanged.
			expect(
				frames.some((f) => f.all.some((l) => l.includes("approved by"))),
				`${W}x${H}: no policy byline survives anywhere (R1.5 ⑤)`,
			).toBe(false);
		}
	});

	it("D3 — the box chrome is intact at every frame (the cells' rows never overlap the box)", () => {
		// the D3 residue: a committed or live row landing on the chrome
		// rows (the fold's corner over the box) — the box's own corners
		// are then displaced. The gate pins the box top (row H-3), the
		// input row's walls (row H-2) and the box bottom (row H-1) to
		// their exact shapes at every frame of the replay. The Screen's
		// lines() is 0-indexed: row N = lines[N-1].
		const sizes = [[40, 12], [40, 24], [80, 24]] as const;
		for (const [W, H] of sizes) {
			const { frames } = replay(W, H);
			for (const f of frames) {
				const top = f.lines[H - 4]!;
				const input = f.lines[H - 3]!;
				const bottom = f.lines[H - 2]!;
				expect(top, `${W}x${H} frame ${f.n}: the box top corner`).toMatch(/^╭/);
				expect(top, `${W}x${H} frame ${f.n}: the box top corner`).toMatch(/╮$/);
				expect(input, `${W}x${H} frame ${f.n}: the input row's left wall`).toMatch(/^│/);
				expect(input, `${W}x${H} frame ${f.n}: the input row's right wall`).toMatch(/│$/);
				expect(bottom, `${W}x${H} frame ${f.n}: the box bottom corner`).toMatch(/^╰/);
				expect(bottom, `${W}x${H} frame ${f.n}: the box bottom corner`).toMatch(/╯$/);
			}
		}
	});
});
