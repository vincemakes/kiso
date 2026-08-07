/**
 * TUI #17 — the 5th probe class (SCREEN STATE): the minimal VT screen.
 *
 * A FIXED rows×cols grid, exactly like the real terminal: CUP rows are
 * grid rows and never drift; an LF at the last row SCROLLS (every row
 * shifts up, the top row leaves the grid); a write past the right edge
 * soft-wraps onto the next row (marked as the continuation of the
 * logical line above); an erased row is no longer a continuation.
 * resize() reflows: the logical lines re-wrap at the new width, the
 * last `rows` lines stay visible (the content anchors to the bottom).
 *
 * Parses ONLY CUP / EL / ED / LF / CR (SGR and every other CSI is
 * skipped). The PTY byte stream feeds it, with the driver's TIOCSWINSZ
 * offsets applied as resize() calls, so the emulated geometry tracks
 * the process's. The assertions read the SCREEN — what the byte probes
 * (LF/CSI counts) cannot see: the response text counted once (the tail
 * ghost), the separator rows in the body region (the dock wall), the
 * fold's own row with the /think suffix, no reflow-cut "[" residue.
 *
 * A TEST HELPER — not counted in the gate line budgets.
 */

interface Row {
	text: string;
	/** true = this row is the soft-wrap continuation of the row above. */
	cont: boolean;
}

/** Wrap a text by display width (the fixture content is 1-cell per char). */
function wrapText(text: string, cols: number): string[] {
	if (cols < 1 || text.length <= cols) return [text];
	const out: string[] = [];
	for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols));
	return out;
}

export class VtScreen {
	#grid: Row[] = [];
	#rows: number;
	#cols: number;
	#r = 0; // the cursor row — a GRID index
	#c = 0;

	constructor(rows: number, cols: number) {
		this.#rows = rows;
		this.#cols = cols;
		for (let i = 0; i < rows; i += 1) this.#grid.push({ text: "", cont: false });
	}

	get rows(): number {
		return this.#rows;
	}

	get cols(): number {
		return this.#cols;
	}

	/** The visible screen — the grid rows. */
	visible(): string[] {
		return this.#grid.map((r) => r.text);
	}

	/** The rows that are the continuation of the row above. */
	continuations(): boolean[] {
		return this.#grid.map((r) => r.cont);
	}

	/** Reflow: re-wrap every LOGICAL line at the new width; the terminal's
	 *  semantics — the content KEEPS its position (the top), the new rows
	 *  appear at the bottom on a grow; a shrink keeps the BOTTOM rows (the
	 *  visible window is the last `rows` of the buffer). */
	resize(rows: number, cols: number): void {
		const logical: string[] = [];
		for (const row of this.#grid) {
			if (row.cont) logical[logical.length - 1]! += row.text;
			else logical.push(row.text);
		}
		const reflowed: Row[] = [];
		for (const text of logical) {
			const wrapped = wrapText(text, cols);
			wrapped.forEach((t, i) => reflowed.push({ text: t, cont: i > 0 }));
		}
		let grid: Row[];
		if (reflowed.length < rows) {
			// grow: the content keeps its TOP position — pad at the bottom
			grid = reflowed;
			while (grid.length < rows) grid.push({ text: "", cont: false });
		} else {
			// shrink: the visible window is the last `rows` rows
			grid = reflowed.slice(reflowed.length - rows);
		}
		this.#grid = grid;
		this.#rows = rows;
		this.#cols = cols;
		this.#r = Math.min(this.#r, this.#grid.length - 1);
	}

	/** Feed a byte chunk. The markers are BYTE offsets — the feed is
	 *  chunked at those offsets by the test. */
	write(bytes: Uint8Array): void {
		let i = 0;
		while (i < bytes.length) {
			const b = bytes[i]!;
			if (b === 0x1b) {
				i = this.#csi(bytes, i);
				continue;
			}
			if (b === 0x0a) {
				this.#lf();
				i += 1;
				continue;
			}
			if (b === 0x0d) {
				this.#c = 0;
				i += 1;
				continue;
			}
			// a printable run — decode the UTF-8 bytes as one string
			let j = i;
			while (j < bytes.length && bytes[j]! !== 0x1b && bytes[j]! !== 0x0a && bytes[j]! !== 0x0d) j += 1;
			const chunk = Buffer.from(bytes.subarray(i, j)).toString("utf8");
			for (const ch of chunk) this.#put(ch);
			i = j;
		}
	}

	/** One CSI sequence starting at bytes[i] === ESC. Returns the index
	 *  after the sequence. CUP/EL/ED handled; everything else skipped. */
	#csi(bytes: Uint8Array, i: number): number {
		if (bytes[i + 1] !== 0x5b) return i + 1; // a bare ESC
		let j = i + 2;
		while (j < bytes.length && /[0-9;?]/.test(String.fromCharCode(bytes[j]!))) j += 1;
		if (j >= bytes.length) return bytes.length;
		const fin = String.fromCharCode(bytes[j]!);
		const params = Buffer.from(bytes.subarray(i + 2, j)).toString("ascii");
		if (fin === "H" || fin === "f") {
			const [rRaw, cRaw] = params.split(";");
			const r = rRaw === undefined || rRaw === "" ? 1 : Number.parseInt(rRaw, 10);
			const c = cRaw === undefined || cRaw === "" ? 1 : Number.parseInt(cRaw, 10);
			this.#r = Math.max(0, Math.min(this.#grid.length - 1, r - 1));
			this.#c = Math.max(0, c - 1);
		} else if (fin === "K") {
			const n = params === "" ? 0 : Number.parseInt(params, 10);
			const row = this.#grid[this.#r]!;
			if (n === 2) row.text = "";
			else if (n === 1) row.text = row.text.slice(this.#c);
			else row.text = row.text.slice(0, this.#c);
			// An ERASED row is no longer a soft-wrap continuation — the
			// next commit's EL at the same write row clears the previous
			// line's overflow tail; without the reset, the reflow would
			// treat the blank as part of the line above (the merge).
			row.cont = false;
		} else if (fin === "J") {
			const n = params === "" ? 0 : Number.parseInt(params, 10);
			if (n === 2) {
				for (let k = 0; k < this.#grid.length; k += 1) this.#grid[k] = { text: "", cont: false };
			} else if (n === 1) {
				const row = this.#grid[this.#r]!;
				for (let k = 0; k <= this.#r; k += 1) this.#grid[k] = { text: "", cont: false };
				row.text = row.text.slice(this.#c);
			} else {
				// 0: from the cursor to the END of the screen
				const row = this.#grid[this.#r]!;
				row.text = row.text.slice(0, this.#c);
				for (let k = this.#r + 1; k < this.#grid.length; k += 1) this.#grid[k] = { text: "", cont: false };
			}
		}
		// SGR and everything else: ignored
		return j + 1;
	}

	#lf(): void {
		if (this.#r === this.#grid.length - 1) {
			// at the last row: SCROLL — every row shifts up, the top row
			// leaves the grid, a blank row enters at the bottom
			for (let k = 0; k < this.#grid.length - 1; k += 1) this.#grid[k] = this.#grid[k + 1]!;
			this.#grid[this.#grid.length - 1] = { text: "", cont: false };
		} else {
			this.#r += 1;
		}
		this.#c = 0;
	}

	#put(ch: string): void {
		if (this.#c >= this.#cols) {
			// the soft-wrap — the terminal continues the write on the next
			// row, marking it as the continuation of this logical line
			this.#r = Math.min(this.#r + 1, this.#grid.length - 1);
			this.#c = 0;
			this.#grid[this.#r]!.cont = true;
		}
		const row = this.#grid[this.#r]!;
		const pad = this.#c - row.text.length;
		if (pad > 0) row.text += " ".repeat(pad);
		row.text = row.text.slice(0, this.#c) + ch + row.text.slice(this.#c + 1);
		this.#c += 1;
	}
}
