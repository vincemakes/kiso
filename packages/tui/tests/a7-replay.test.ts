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

/** The real-terminal cell model — the a3-repro replay (UTF-8 text, CJK
 *  wide chars, CUP/G/EL/LF/CR/wrap, the LF-at-the-bottom scroll). The
 *  screen is the acceptance ground: what the terminal KEEPS is what a
 *  human sees — a stale live copy left above a committed section is
 *  visible duplication. */
export class Screen {
	readonly W: number;
	readonly H: number;
	rows: string[][];
	/** the SCROLLBACK — every row evicted by a bottom scroll (a real
	 *  terminal keeps it forever; the A7 duplication lives there). */
	history: string[][] = [];
	r = 0;
	c = 0;
	pending = false;

	constructor(W: number, H: number) {
		this.W = W;
		this.H = H;
		this.rows = Array.from({ length: H }, () => Array.from({ length: W }, () => " "));
	}

	/** every line the terminal has ever shown — scrollback then visible. */
	allLines(): string[] {
		return [...this.history.map((row) => row.join("")), ...this.rows.map((row) => row.join(""))];
	}

	charWidth(cp: number): number {
		if (
			(0x1100 <= cp && cp <= 0x115f) ||
			(0x2e80 <= cp && cp <= 0x303e) ||
			(0x3041 <= cp && cp <= 0x33ff) ||
			(0x3400 <= cp && cp <= 0x4dbf) ||
			(0x4e00 <= cp && cp <= 0x9fff) ||
			(0xa000 <= cp && cp <= 0xa4cf) ||
			(0xa960 <= cp && cp <= 0xa97f) ||
			(0xac00 <= cp && cp <= 0xd7a3) ||
			(0xf900 <= cp && cp <= 0xfaff) ||
			(0xfe10 <= cp && cp <= 0xfe19) ||
			(0xfe30 <= cp && cp <= 0xfe6f) ||
			(0xff00 <= cp && cp <= 0xff60) ||
			(0xffe0 <= cp && cp <= 0xffe6) ||
			(0x1f300 <= cp && cp <= 0x1f64f) ||
			(0x1f900 <= cp && cp <= 0x1f9ff) ||
			(0x20000 <= cp && cp <= 0x3fffd)
		) {
			return 2;
		}
		return 1;
	}

	scroll(): void {
		this.history.push(this.rows.shift()!);
		this.rows.push(Array.from({ length: this.W }, () => " "));
		// the cursor STAYS at the bottom row — a real terminal's LF at
		// the last line scrolls the window up and keeps the cursor on
		// the last line (the fresh blank). The old decrement walked the
		// cursor up with the scrolled content — every bottom-scroll then
		// shifted the frame's relative chrome march one row high (the
		// box top erased by the gap ELs — a phantom).
	}

	feed(bytes: string): void {
		const text = bytes; // already decoded UTF-8 (the writes are JS strings)
		let i = 0;
		const n = text.length;
		while (i < n) {
			const ch = text[i]!;
			if (ch === "\x1b") {
				if (text[i + 1] === "[") {
					let j = i + 2;
					if (text[j] === "?") j += 1;
					const params: string[] = [];
					let cur = "";
					while (j < n && !"ABCDGHJKlmhfnru".includes(text[j]!)) {
						if (text[j] === ";") {
							params.push(cur);
							cur = "";
						} else if (/[0-9]/.test(text[j]!)) {
							cur += text[j];
						} else {
							break;
						}
						j += 1;
					}
					if (j < n) {
						const fin = text[j]!;
						params.push(cur);
						const nums = params.map((p) => (p === "" ? 1 : Number(p)));
						if (fin === "A") {
							this.pending = false;
							this.r = Math.max(0, this.r - nums[0]!);
						} else if (fin === "B") {
							this.pending = false;
							this.r = Math.min(this.H - 1, this.r + nums[0]!);
						} else if (fin === "C") {
							this.pending = false;
							this.c = Math.min(this.W - 1, this.c + nums[0]!);
						} else if (fin === "D") {
							this.pending = false;
							this.c = Math.max(0, this.c - nums[0]!);
						} else if (fin === "G") {
							this.pending = false;
							this.c = Math.max(0, Math.min(this.W - 1, nums[0]! - 1));
						} else if (fin === "H") {
							this.pending = false;
							this.r = Math.max(0, Math.min(this.H - 1, nums[0]! - 1));
							this.c = Math.max(0, Math.min(this.W - 1, nums[1]! - 1));
						} else if (fin === "K") {
							this.pending = false;
							for (let cc = this.c; cc < this.W; cc += 1) this.rows[this.r]![cc] = " ";
						} else if (fin === "J") {
							this.pending = false;
							for (let rr = this.r; rr < this.H; rr += 1) {
								for (let cc = 0; cc < this.W; cc += 1) this.rows[rr]![cc] = " ";
							}
						} else if (fin === "m" || fin === "u" || fin === "h" || fin === "l" || fin === "r" || fin === "f" || fin === "n") {
							this.pending = false;
						}
					}
					i = j + 1;
					continue;
				} else {
					i += 2;
					continue;
				}
			} else if (ch === "\r") {
				this.pending = false;
				this.c = 0;
			} else if (ch === "\n") {
				if (this.r === this.H - 1) {
					this.scroll();
				} else {
					this.r += 1;
				}
				this.pending = false;
			} else {
				if (this.pending) {
					this.c = 0;
					if (this.r === this.H - 1) this.scroll();
					else this.r += 1;
					this.pending = false;
				}
				const cp = ch.codePointAt(0)!;
				const cw = this.charWidth(cp);
				if (this.c + cw > this.W) {
					this.c = 0;
					if (this.r === this.H - 1) this.scroll();
					else this.r += 1;
				}
				if (cw === 2 && this.c + 1 < this.W) {
					this.rows[this.r]![this.c] = ch;
					this.rows[this.r]![this.c + 1] = "";
				} else {
					this.rows[this.r]![this.c] = ch;
				}
				this.c += cw;
				if (this.c >= this.W) {
					this.c = this.W;
					this.pending = true;
				}
			}
			i += 1;
		}
	}

	lines(): string[] {
		return this.rows.map((row) => row.join(""));
	}

	/** The marker row-BLOCKS (a contiguous run of marker rows = one copy)
	 *  and the marker ROW count (two adjacent copies = one block, two
	 *  rows). */
	counts(marker: string): { blocks: number; rows: number } {
		const lines = this.lines();
		let blocks = 0;
		let rows = 0;
		let inBlock = false;
		for (const line of lines) {
			const has = line.includes(marker);
			if (has) {
				rows += 1;
				if (!inBlock) {
					blocks += 1;
					inBlock = true;
				}
			} else {
				inBlock = false;
			}
		}
		return { blocks, rows };
	}

	/** The marker row-BLOCKS over the FULL history — scrollback + visible. */
	countsAll(marker: string): { blocks: number; rows: number } {
		const lines = this.allLines();
		let blocks = 0;
		let rows = 0;
		let inBlock = false;
		for (const line of lines) {
			const has = line.includes(marker);
			if (has) {
				rows += 1;
				if (!inBlock) {
					blocks += 1;
					inBlock = true;
				}
			} else {
				inBlock = false;
			}
		}
		return { blocks, rows };
	}

	/** The longest run of fully-blank rows. */
	maxBlankRun(): number {
		let max = 0;
		let run = 0;
		for (const line of this.lines()) {
			if (line.trim() === "") {
				run += 1;
				max = Math.max(max, run);
			} else {
				run = 0;
			}
		}
		return max;
	}
}

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
			// A6: the tool header is widthCut, never a wrapped fold — the
			// 40-col row cannot hold the full decider tail ("approved by
			// mode:default" alone is 36 cells), so the cut row names the
			// decider's tail and the ellipsis marks the honest cut; the
			// 80-col rows carry the FULL string.
			const decider = W >= 80 ? "approved by mode:default" : "approved by ";
			expect(
				frames.some((f) => f.all.some((l) => l.includes(decider) && (W >= 80 || l.includes("…")))),
				`${W}x${H}: the extension-approved cell's head row names the decider (A5)`,
			).toBe(true);
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
