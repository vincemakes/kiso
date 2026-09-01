/**
 * The real-terminal cell model, extracted from a7-replay so other
 * suites can assert on the SCREEN without importing a test file (which
 * would run its tests as a side effect).
 */

/** The real-terminal cell model — the a3-repro replay (UTF-8 text, CJK
 *  wide chars, CUP/G/EL/LF/CR/wrap, the LF-at-the-bottom scroll). The
 *  screen is the acceptance ground: what the terminal KEEPS is what a
 *  human sees — a stale live copy left above a committed section is
 *  visible duplication. */
export class Screen {
	W: number;
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

	/** DC-34 — the terminal's width changing, WITHOUT reflow.
	 *
	 *  Terminal.app does not re-wrap what it has already drawn: a row
	 *  folded at the old width stays folded, in the scrollback and on
	 *  the screen alike. kiso's own rows are hard lines regardless —
	 *  frames run with autowrap off and every row is placed by cursor
	 *  address — so no terminal can rejoin them. Widening therefore
	 *  makes each row LONGER and never makes them fewer, which is
	 *  exactly the asymmetry the defect lives in.
	 *
	 *  Only the grid's width moves. The cursor, the scrollback and
	 *  every drawn cell stay where they are. */
	resizeTo(W: number): void {
		// WIDEN ONLY. A real terminal REFLOWS on a narrowing and pushes
		// what it displaces into its scrollback (see the compositor's own
		// D18 and TT-1B comments); truncating would model a terminal that
		// does not exist, and a gate built on it would be measuring
		// fiction. Narrowing needs its own model and does not have one
		// yet — DC-34 rider 2.
		if (W < this.W) throw new Error("Screen.resizeTo models a WIDEN only — see DC-34 rider 2");
		const pad = (row: string[]): string[] => (W <= row.length ? row.slice(0, W) : [...row, ...Array.from({ length: W - row.length }, () => " ")]);
		this.rows = this.rows.map(pad);
		this.history = this.history.map(pad);
		this.W = W;
		this.c = Math.min(this.c, W - 1);
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
