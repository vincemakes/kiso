/**
 * TT-1B — the scrollback-capturing mini VT (an INSTRUMENT, not a gate).
 *
 * The house emulator drops scrolled rows on the floor (the R2pre ②
 * finding could not be SEEN by any gate — the screen always repaints
 * clean). This replay terminal keeps them: LF at the bottom row pushes
 * row 1 into `scrollback`, CUP clamps to the screen exactly as a real
 * terminal does (the TUI2-MD-1 loss mechanism — bytes painted past H
 * land nowhere), and resize keeps the top rows. Content-loss and
 * content-duplication claims become assertable:
 *
 *   lost:       a committed line in neither scrollback nor screen
 *   duplicated: a committed line entering scrollback twice
 *
 * Deliberately small: CUP/CHA/EL/ED/up/down/CR/LF + SGR-strip + the
 * DEC private modes the compositor emits (ignored). ASCII-cell fixtures
 * only — width — the compositor's own width discipline is gated
 * elsewhere.
 */

export class VtScrollback {
	#w: number;
	#h: number;
	#rows: string[][];
	#r = 1; // 1-based cursor row
	#c = 1; // 1-based cursor col
	readonly scrollback: string[] = [];

	constructor(w: number, h: number) {
		this.#w = w;
		this.#h = h;
		this.#rows = Array.from({ length: h }, () => []);
	}

	resize(w: number, h: number): void {
		this.#w = w;
		if (h < this.#h) {
			// a real terminal keeps the BOTTOM of the viewport on a shrink
			// and pushes the top rows into the scrollback (the prompt stays)
			const pushed = this.#h - h;
			for (let k = 0; k < pushed; k += 1) this.scrollback.push(this.line(k + 1));
			this.#rows = this.#rows.slice(pushed);
			this.#r = Math.max(1, this.#r - pushed);
		} else {
			while (this.#rows.length < h) this.#rows.push([]);
		}
		this.#h = h;
		this.#r = Math.min(this.#r, h);
		this.#c = Math.min(this.#c, w);
	}

	#row(): string[] {
		return this.#rows[this.#r - 1]!;
	}

	#scroll(): void {
		this.scrollback.push(this.line(1));
		this.#rows.shift();
		this.#rows.push([]);
	}

	feed(bytes: string): void {
		let i = 0;
		while (i < bytes.length) {
			const ch = bytes[i]!;
			if (ch === "\x1b") {
				const m = /^\x1b\[([0-9;?]*)([A-Za-z])/.exec(bytes.slice(i));
				if (m === null) {
					i += 1; // a bare ESC in a fixture — skip it
					continue;
				}
				const [whole, args, cmd] = [m[0], m[1]!, m[2]!];
				const n = (d: number): number => (args === "" ? d : Number(args.split(";")[0]!) || d);
				if (cmd === "H") {
					const parts = args.split(";");
					this.#r = Math.min(this.#h, Math.max(1, Number(parts[0] ?? "1") || 1));
					this.#c = Math.min(this.#w, Math.max(1, Number(parts[1] ?? "1") || 1));
				} else if (cmd === "G") this.#c = Math.min(this.#w, Math.max(1, n(1)));
				else if (cmd === "A") this.#r = Math.max(1, this.#r - n(1));
				else if (cmd === "B") this.#r = Math.min(this.#h, this.#r + n(1));
				else if (cmd === "K") this.#row().length = this.#c - 1;
				else if (cmd === "J") for (let rr = this.#r; rr <= this.#h; rr += 1) this.#rows[rr - 1]!.length = rr === this.#r ? this.#c - 1 : 0;
				// m (SGR), h/l (modes), r (margins) — stripped
				i += whole.length;
				continue;
			}
			if (ch === "\n") {
				if (this.#r === this.#h) this.#scroll();
				else this.#r += 1;
				i += 1;
				continue;
			}
			if (ch === "\r") {
				this.#c = 1;
				i += 1;
				continue;
			}
			const row = this.#row();
			while (row.length < this.#c - 1) row.push(" ");
			row[this.#c - 1] = ch;
			this.#c = Math.min(this.#w + 1, this.#c + 1);
			i += 1;
		}
	}

	line(r: number): string {
		return (this.#rows[r - 1] ?? []).join("").replace(/\s+$/, "");
	}

	/** Every line a reader can reach: the scrollback then the screen. */
	allLines(): string[] {
		return [...this.scrollback, ...Array.from({ length: this.#h }, (_, k) => this.line(k + 1))];
	}
}
