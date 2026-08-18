/**
 * TUI2-R2pre ① — a WIDTH-AWARE VT screen, and the REFERENCE width it
 * measures with.
 *
 * The house emulator (apps/cli/tests/helpers/vt-screen.ts) advances the
 * cursor ONE column per character, so a glyph the compositor measured
 * wrong is invisible to it: the emulator makes the same mistake and the
 * two agree. This screen measures with `referenceWidth` below — derived
 * from Unicode's East_Asian_Width (W/F) and Emoji_Presentation=Yes, NOT
 * from the source table — so a disagreement between what the compositor
 * budgeted and what a terminal actually does shows up as a soft wrap,
 * which is what it is on a real screen.
 *
 * A TEST HELPER — not counted in the gate line budgets.
 */

/** Unicode Emoji_Presentation=Yes inside U+2000..U+2BFF (the singles and
 *  short runs — the rest of the block is narrow, ✓ ✗ ⚠ ⏸ included). */
const EP_SINGLES: readonly (readonly [number, number])[] = [
	[0x231a, 0x231b],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
];

/** The reference terminal width of one code point. */
export function referenceWidth(cp: number): number {
	// the East Asian Wide / Fullwidth ranges
	if (cp >= 0x1100 && cp <= 0x115f) return 2;
	if (cp >= 0x2e80 && cp <= 0x303e) return 2;
	if (cp >= 0x3041 && cp <= 0x33ff) return 2;
	if (cp >= 0x3400 && cp <= 0x4dbf) return 2;
	if (cp >= 0x4e00 && cp <= 0x9fff) return 2;
	if (cp >= 0xa000 && cp <= 0xa4cf) return 2;
	if (cp >= 0xa960 && cp <= 0xa97f) return 2;
	if (cp >= 0xac00 && cp <= 0xd7a3) return 2;
	if (cp >= 0xf900 && cp <= 0xfaff) return 2;
	if (cp >= 0xfe10 && cp <= 0xfe19) return 2;
	if (cp >= 0xfe30 && cp <= 0xfe6f) return 2;
	if (cp >= 0xff00 && cp <= 0xff60) return 2;
	if (cp >= 0xffe0 && cp <= 0xffe6) return 2;
	// the emoji-presentation planes
	if (cp === 0x1f004 || cp === 0x1f0cf) return 2;
	if (cp >= 0x1f18e && cp <= 0x1f19a) return 2;
	if (cp >= 0x1f200 && cp <= 0x1f251) return 2;
	if (cp >= 0x1f300 && cp <= 0x1f64f) return 2;
	if (cp >= 0x1f680 && cp <= 0x1f6ff) return 2;
	if (cp >= 0x1f7e0 && cp <= 0x1f7eb) return 2;
	if (cp >= 0x1f900 && cp <= 0x1f9ff) return 2;
	if (cp >= 0x1fa70 && cp <= 0x1faff) return 2;
	if (cp >= 0x20000 && cp <= 0x3fffd) return 2;
	for (const [lo, hi] of EP_SINGLES) if (cp >= lo && cp <= hi) return 2;
	return 1;
}

/** The reference terminal width of a string (SGR + the cursor APC stripped). */
export function referenceWidthOf(text: string): number {
	const bare = text.replace(/\x1b_\[kiso-cur\]\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	let w = 0;
	for (const ch of bare) w += referenceWidth(ch.codePointAt(0)!);
	return w;
}

interface Row {
	cells: (string | null | undefined)[];
	cont: boolean;
}

const blank = (): Row => ({ cells: [], cont: false });

/** A fixed rows×cols grid that wraps by REFERENCE width and KEEPS the rows
 *  that scroll off the top (the scrollback — what "blank gaps in the
 *  history" is a statement about). */
export class WideScreen {
	#grid: Row[] = [];
	#rows: number;
	#cols: number;
	#r = 0;
	#c = 0;
	readonly scrollback: string[] = [];

	constructor(rows: number, cols: number) {
		this.#rows = rows;
		this.#cols = cols;
		for (let i = 0; i < rows; i += 1) this.#grid.push(blank());
	}

	#text(row: Row): string {
		let s = "";
		for (let i = 0; i < row.cells.length; i += 1) {
			const cell = row.cells[i];
			if (cell === undefined) s += " ";
			else if (cell === null) continue; // a wide glyph's second column
			else s += cell;
		}
		return s.replace(/\s+$/, "");
	}

	/** The visible grid. */
	visible(): string[] {
		return this.#grid.map((r) => this.#text(r));
	}

	/** Everything the terminal holds — the scrollback then the screen. */
	all(): string[] {
		return [...this.scrollback, ...this.visible()];
	}

	#scroll(): void {
		this.scrollback.push(this.#text(this.#grid[0]!));
		for (let k = 0; k < this.#grid.length - 1; k += 1) this.#grid[k] = this.#grid[k + 1]!;
		this.#grid[this.#grid.length - 1] = blank();
	}

	#lf(): void {
		if (this.#r === this.#grid.length - 1) this.#scroll();
		else this.#r += 1;
		this.#c = 0;
	}

	#put(ch: string): void {
		const w = referenceWidth(ch.codePointAt(0)!);
		if (this.#c + w > this.#cols) {
			// the real terminal's soft wrap — the glyph moves to the next row
			if (this.#r === this.#grid.length - 1) this.#scroll();
			else this.#r += 1;
			this.#c = 0;
			this.#grid[this.#r]!.cont = true;
		}
		const row = this.#grid[this.#r]!;
		row.cells[this.#c] = ch;
		if (w === 2) row.cells[this.#c + 1] = null;
		this.#c += w;
	}

	write(s: string): void {
		let i = 0;
		while (i < s.length) {
			const ch = s[i]!;
			if (ch === "\x1b") {
				i = this.#esc(s, i);
				continue;
			}
			if (ch === "\n") {
				this.#lf();
				i += 1;
				continue;
			}
			if (ch === "\r") {
				this.#c = 0;
				i += 1;
				continue;
			}
			const chr = String.fromCodePoint(s.codePointAt(i)!);
			this.#put(chr);
			i += chr.length;
		}
	}

	#esc(s: string, i: number): number {
		if (s[i + 1] === "_") {
			const end = s.indexOf("\x1b\\", i + 2);
			return end === -1 ? s.length : end + 2;
		}
		if (s[i + 1] !== "[") return i + 1;
		let j = i + 2;
		while (j < s.length && /[-0-9;?]/.test(s[j]!)) j += 1;
		if (j >= s.length) return s.length;
		const fin = s[j]!;
		const params = s.slice(i + 2, j);
		const num = (d: number): number => (params === "" ? d : Number.parseInt(params, 10));
		if (fin === "H" || fin === "f") {
			const [rRaw, cRaw] = params.split(";");
			const r = rRaw === undefined || rRaw === "" ? 1 : Number.parseInt(rRaw, 10);
			const c = cRaw === undefined || cRaw === "" ? 1 : Number.parseInt(cRaw, 10);
			this.#r = Math.max(0, Math.min(this.#grid.length - 1, r - 1));
			this.#c = Math.max(0, c - 1);
		} else if (fin === "K") {
			const n = num(0);
			const row = this.#grid[this.#r]!;
			if (n === 2) row.cells = [];
			else if (n === 1) for (let k = 0; k <= this.#c; k += 1) row.cells[k] = undefined;
			else row.cells = row.cells.slice(0, this.#c);
			row.cont = false;
		} else if (fin === "J") {
			const n = num(0);
			if (n === 2) for (let k = 0; k < this.#grid.length; k += 1) this.#grid[k] = blank();
			else if (n === 1) for (let k = 0; k <= this.#r; k += 1) this.#grid[k] = blank();
			else {
				this.#grid[this.#r]!.cells = this.#grid[this.#r]!.cells.slice(0, this.#c);
				for (let k = this.#r + 1; k < this.#grid.length; k += 1) this.#grid[k] = blank();
			}
		} else if (fin === "A") this.#r = Math.max(0, this.#r - num(1));
		else if (fin === "B") this.#r = Math.min(this.#grid.length - 1, this.#r + num(1));
		else if (fin === "G") this.#c = Math.max(0, num(1) - 1);
		else if (fin === "D") this.#c = Math.max(0, this.#c - num(1));
		else if (fin === "C") this.#c += num(1);
		return j + 1;
	}
}

/** The longest run of all-blank rows strictly INSIDE the given rows (the
 *  leading and trailing blanks are not a gap — they are the edges). */
export function longestInnerBlankRun(rows: readonly string[]): { run: number; at: number } {
	let first = 0;
	while (first < rows.length && rows[first]!.trim() === "") first += 1;
	let last = rows.length - 1;
	while (last >= 0 && rows[last]!.trim() === "") last -= 1;
	let run = 0;
	let best = 0;
	let bestAt = -1;
	for (let i = first; i <= last; i += 1) {
		if (rows[i]!.trim() === "") {
			run += 1;
			if (run > best) {
				best = run;
				bestAt = i;
			}
		} else run = 0;
	}
	return { run: best, at: bestAt };
}
