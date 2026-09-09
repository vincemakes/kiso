/**
 * The approval / ask / pick PANEL's input controller — S5 (finding C10).
 *
 * The editor parses BYTES and owns the composer buffer; this controller
 * owns the panel's STATE and answers KEYS. One key is handled by at most
 * one band, in an order the editor keeps in one place: the panel first,
 * then the session picker, then the composer's own bands. What the
 * panel may do to the composer is the `BandHost` surface and nothing
 * else: it types its amend reason, its custom ask answer and its custom
 * pick into the composer, stashes the composer at open, restores it at
 * close — that is the whole coupling, and it is visible here.
 *
 * DECLARED MOVE (S5, 2026-09-06): every method below stood in editor.ts
 * — `#panelMove` … `#panelClose`, `beginPanel`, `cancelPanel`,
 * `panelState`, the panel block of `feed()`, the ↑↓/← branches of `#csi`
 * and the mouse hit. The bodies are the same; only the buffer access
 * goes through the host.
 */
import {
	PICK_MAX,
	panelOptions,
	saferDegradedNote,
	type AskRuntime,
	type PanelPhase,
	type PanelState,
	type PanelVerdict,
	type PanelView,
	type PickRuntime,
	startLevel,
	stepLevel,
	type SaferAnswer,
	type SaferOption,
} from "./approval-panel.js";
import { askCommitCustom, askKey, askOnCustomRow, askStart } from "./ask-panel.js";

/** The composer's buffer, as a band puts it aside and gets it back. */
export interface BufferStash {
	readonly chars: number[];
	readonly cursor: number;
	readonly scroll: number;
}

/** The composer, as a band controller is allowed to see it. Every
 *  entry is something a panel or the session picker does to the
 *  editor; nothing a band needs is reached any other way. */
export interface BandHost {
	/** The buffer as text. */
	line(): string;
	/** The buffer with its paste capsules expanded — the text that would leave the editor. */
	expandPastes(line: string): string;
	/** Empty the buffer: chars, cursor, scroll and the ↑↓ goal column. */
	clear(): void;
	/** Type one code point at the cursor. */
	insert(cp: number): void;
	/** Insert the buffer's newline — a pasted line break while a band is up. */
	newline(): void;
	stash(): BufferStash;
	restore(s: BufferStash): void;
	reflow(): void;
	render(): void;
	syncMouse(): void;
	/** A panel opening closes the composer's own bands: the menu, the queue-pop mode, the @ picker. */
	closeBands(): void;
	/** The Enter that closed a panel must not also submit the restored buffer. */
	swallowNextEnter(): void;
}

/** A key the editor has already parsed. `enter.crlf` says the bytes
 *  were CR LF, so a consumed Enter is two bytes in a paste. */
export type BandKey = { kind: "esc" } | { kind: "enter"; crlf: boolean } | { kind: "tab" } | { kind: "char"; ch: string };

/** The option rows' place on screen, as the compositor reported it (TUI2-R3v2 ②). */
export interface PanelRowSpan {
	readonly top: number;
	readonly count: number;
	readonly first?: number;
}

export class PanelInput {
	// W21: the panel state machine — the approval/trust panel owns the
	// interaction while up: the digit/y/n/esc/tab routing, the rule
	// input, the tab-amend feedback, the phase/selection the compositor
	// renders. The menu never opens while a panel is up; the pre-panel
	// buffer is stashed at open and restored at close (commit AND
	// cancel) — the panel's rule/feedback text never leaks into the
	// user's next turn.
	#panel: {
		view: PanelView;
		phase: PanelPhase;
		/** TUI2-R3v2 ①: the highlighted row, 0-based into panelOptions. */
		cursor: number;
		/** TUI2-R3v2 ①: one dim line the panel owes the human after a
		 *  gesture that could not do what it offered. Cleared by the next
		 *  gesture — a stale apology is its own kind of lie. */
		note: string | null;
		/** TUI2-R3v2 ③: the caller's safer-options provider. Absent = the
		 *  button degrades honestly rather than pretending. R3v2-F1: it may
		 *  now resolve a FAILURE that names its cause, not only `null`. */
		safer: (() => Promise<SaferAnswer>) | undefined;
		/** TUI2-R3v2 ③: the safer list's walk, once the answer landed. */
		saferRun: { options: readonly SaferOption[]; cursor: number } | null;
		/** KC3.5: the ask's walk — non-null exactly for an ask view. */
		ask: AskRuntime | null;
		/** TUI2-R2 ④: the pick panel's cursor + phase; null on every other
		 *  flavour. */
		pick: PickRuntime | null;
		onCommit: (v: PanelVerdict) => void;
		stash: BufferStash;
	} | null = null;
	/** TUI2-R3v2 ③: the safer ask's generation. A panel the human escaped
	 *  must not be resurrected by a promise nobody is waiting for. */
	#saferToken = 0;

	constructor(private readonly host: BandHost) {}

	up(): boolean {
		return this.#panel !== null;
	}

	/** W21: open the approval panel. The current buffer is stashed
	 *  (restored at close — commit AND cancel), the panel takes the
	 *  keys and the input row's lead, the composer's own bands close. */
	begin(view: PanelView, onCommit: (v: PanelVerdict) => void, opts?: { safer?: () => Promise<SaferAnswer> }): void {
		this.#panel = {
			view,
			phase: "options",
			cursor: 0,
			note: null,
			safer: opts?.safer,
			saferRun: null,
			ask: view.ask === undefined ? null : askStart(view.ask),
			pick: view.pick === undefined ? null : { cursor: 0, phase: "options" as const, level: startLevel(view.pick.options[0]) },
			onCommit,
			stash: this.host.stash(),
		};
		this.host.clear();
		this.host.closeBands();
		this.host.syncMouse();
		this.host.render();
	}

	/** W21: cancel the panel — the SIGINT path's pair to begin. */
	cancel(): void {
		this.#close({ action: "cancel" });
	}

	/** W21: the compositor's bound view — the phase/selection while the
	 *  panel is up, null otherwise. */
	state(): PanelState | null {
		const panel = this.#panel;
		if (panel === null) return null;
		return {
			view: panel.view,
			phase: panel.phase,
			cursor: panel.cursor,
			...(panel.note === null ? {} : { note: panel.note }),
			...(panel.saferRun === null ? {} : { safer: panel.saferRun }),
			...(panel.ask === null ? {} : { ask: panel.ask }),
			...(panel.pick === null ? {} : { pick: panel.pick }),
		};
	}

	/**
	 * A parsed key while the panel is up. Returns the bytes it consumed,
	 * or null when the key falls through to the composer — the amend
	 * reason, a custom ask answer and a custom pick are typed into the
	 * composer through the editor's ordinary path, and a control byte
	 * the panel does not claim (ctrl+c, ctrl+z) keeps its meaning.
	 *
	 * The order is the one `feed()` kept: the pick flavour's keys, then
	 * the ask flavour's, then the keys every flavour shares.
	 */
	feed(key: BandKey, pasting: boolean): number | null {
		const panel = this.#panel;
		if (panel === null) return null;
		const enterBytes = key.kind === "enter" && key.crlf ? 2 : 1;
		if (panel.pick !== null) {
			const typing = panel.pick.phase === "custom";
			if (key.kind === "esc") {
				this.#pickPanelEsc();
				return 1;
			}
			if (key.kind === "enter") {
				if (pasting) {
					this.host.newline();
					return enterBytes;
				}
				this.#pickPanelEnter();
				return 1;
			}
			if (key.kind === "char") {
				const c = key.ch;
				if (!typing && c >= "1" && c <= "9") {
					this.#pickPanelDigit(Number(c) - 1);
					return 1;
				}
				if (!typing && (c === "h" || c === "l") && this.#levelStep(c === "h" ? -1 : 1)) return 1;
				if (!typing && (c === "t" || c === "T") && panel.view.pick?.typeHint !== undefined) {
					panel.pick = { cursor: panel.pick.cursor, phase: "custom", level: panel.pick.level };
					this.host.clear();
					this.host.render();
					return 1;
				}
				if (!typing && c >= " " && c !== "\x7f") return 1;
			}
		}
		if (panel.ask !== null) {
			const typing = panel.ask.phase === "custom";
			if (key.kind === "esc") {
				this.#askStep("esc");
				return 1;
			}
			if (key.kind === "enter") {
				if (pasting) {
					this.host.newline();
					return enterBytes;
				}
				this.#askStep(typing ? "commit" : "enter");
				return 1;
			}
			if (key.kind === "char") {
				const c = key.ch;
				if (askOnCustomRow(panel.view.ask!, panel.ask) && c >= " " && c !== "\x7f") {
					this.#askStep("type");
					this.host.insert(c.codePointAt(0)!);
					this.host.render();
					return 1;
				}
				if (!typing && (c === " " || (c >= "1" && c <= "4") || c === "t" || c === "T")) {
					this.#askStep(c === " " ? "space" : c === "T" ? "t" : c);
					return 1;
				}
				if (!typing && c >= " " && c !== "\x7f") return 1;
			}
		}
		if (key.kind === "esc") {
			this.#panelEsc();
			return 1;
		}
		if (key.kind === "tab") {
			if (panel.phase === "options") this.#panelTab();
			return 1;
		}
		if (key.kind === "enter") {
			if (pasting) {
				this.host.newline();
				return enterBytes;
			}
			this.#panelEnter();
			return 1;
		}
		const c = key.ch;
		if (panel.phase === "safer" && c >= "1" && c <= "9") {
			this.#saferConfirm(Number(c) - 1);
			return 1;
		}
		if (panel.phase === "asking" && c >= " " && c !== "\x7f") return 1;
		if (panel.phase === "options" && panel.ask === null && panel.pick === null && c >= "1" && c <= "9") {
			this.#panelConfirm(Number(c) - 1);
			return 1;
		}
		const optionsPhase =
			panel.pick === null && // a pick has no yes and no no
			panel.phase === "options" && // the amend line is prose
			(panel.ask === null || panel.ask.phase === "options"); // and so is a typed ask answer
		if (optionsPhase && panel.ask === null) {
			if (c === "y" || c === "Y") {
				this.#panelConfirm(0);
				return 1;
			}
			if (c === "n" || c === "N") {
				this.#panelConfirm(panelOptions(panel.view).length - 1);
				return 1;
			}
		}
		return null;
	}

	/** ↑↓ while the panel is up: the flavour's own walk. True when the
	 *  panel owned the key (the caller renders); false when no panel is
	 *  up. A phase without a list (asking) swallows the key. */
	arrow(dir: "up" | "down"): boolean {
		const panel = this.#panel;
		if (panel === null) return false;
		if (panel.pick !== null && panel.pick.phase === "options") {
			const n = Math.min(panel.view.pick!.options.length, PICK_MAX);
			const cur = panel.pick.cursor;
			const next = dir === "up" ? Math.max(0, cur - 1) : Math.min(Math.max(0, n - 1), cur + 1);
			// OR-7: the second axis belongs to the highlighted option, so it
			// re-lands on THAT option's own level. Carrying the previous
			// row's index across would point at a level this model may not
			// have — the silent clamp the coordination note exists to end.
			panel.pick = { cursor: next, phase: "options", level: startLevel(panel.view.pick!.options[next]) };
		} else if (panel.ask !== null && panel.ask.phase === "options") this.#askStep(dir);
		else if (panel.phase === "safer") this.#saferMove(dir === "up" ? -1 : 1);
		else if (panel.phase !== "asking") this.#panelMove(dir === "up" ? -1 : 1);
		return true;
	}

	/** ← while an ask's option row is up walks the ask; while a pick's is
	 *  up it walks the highlighted option's level axis (OR-7); otherwise
	 *  the key is the composer's. */
	left(): boolean {
		if (this.#levelStep(-1)) return true;
		const panel = this.#panel;
		if (panel?.ask == null || panel.ask.phase !== "options") return false;
		this.#askStep("left");
		return true;
	}

	/** → is the level axis's other direction. The ask never owned it (its
	 *  own walk is ← back and enter forward), so this key was the
	 *  composer's alone until OR-7 and still is when no axis is up. */
	right(): boolean {
		return this.#levelStep(1);
	}

	/** One step along the highlighted option's levels. False when there is
	 *  no axis to walk, which is what leaves the key to the composer. */
	#levelStep(dir: -1 | 1): boolean {
		const panel = this.#panel;
		if (panel === null || panel.pick === null || panel.pick.phase !== "options") return false;
		const o = panel.view.pick?.options[panel.pick.cursor];
		if (o?.levels === undefined) return false;
		panel.pick = { cursor: panel.pick.cursor, phase: "options", level: stepLevel(o, panel.pick.level, dir) };
		this.host.render();
		return true;
	}

	/** TUI2-R3v2 ②: a left-button press on the option rows the
	 *  compositor placed. Outside the list — inert. */
	click(span: PanelRowSpan | null | undefined, row: number | undefined): void {
		const panel = this.#panel;
		if (panel === null || (panel.phase !== "options" && panel.phase !== "safer")) return;
		if (span == null || row === undefined || !Number.isFinite(row)) return;
		const offset = row - span.top;
		if (offset < 0 || offset >= span.count) return; // outside the list — inert
		if (panel.phase === "safer") this.#saferConfirm(offset);
		else this.#panelConfirm((span.first ?? 0) + offset);
	}

	// ---- W21 / TUI2-R3v2 ①: the panel state machine ----

	/** ↑↓ — the bar walks the list and STOPS at both ends. A list that
	 *  wraps makes the fastest gesture (hold ↓ to reach the bottom) into
	 *  a gamble about where you landed, and the bottom option here is the
	 *  denial. */
	#panelMove(delta: -1 | 1): void {
		const panel = this.#panel;
		if (panel === null || panel.phase !== "options") return;
		const n = panelOptions(panel.view).length;
		panel.cursor = Math.max(0, Math.min(n - 1, panel.cursor + delta));
		this.host.render();
	}

	#panelConfirm(index: number): void {
		const panel = this.#panel;
		if (panel === null || panel.phase !== "options") return;
		const options = panelOptions(panel.view);
		const option = options[index];
		if (option === undefined) return; // a digit past the list is inert
		panel.cursor = index;
		switch (option.kind) {
			case "allow":
				this.#close({ action: "allow", reason: "" });
				return;
			case "rule":
				this.#close({ action: "allow-rule", rule: panel.view.name });
				return;
			case "safer":
				this.#panelSafer();
				return;
			case "deny":
				if (panel.view.flavor === "approval") this.#panelAmend();
				else this.#close({ action: "deny", reason: "" });
				return;
		}
	}

	/** TUI2-R3v2 ③: ask the caller for safer options. The panel shows
	 *  "asking" until the answer lands; a generation token guards the
	 *  landing so an escaped panel is never resurrected by it. */
	#panelSafer(): void {
		const panel = this.#panel;
		if (panel === null) return;
		const ask = panel.safer;
		panel.phase = "asking";
		panel.note = null;
		this.host.render();
		const token = ++this.#saferToken;
		const settle = (answer: SaferAnswer): void => {
			if (this.#panel !== panel || token !== this.#saferToken) return;
			const options = Array.isArray(answer) ? (answer as readonly SaferOption[]) : null;
			if (options === null || options.length === 0) {
				panel.phase = "options";
				panel.note = saferDegradedNote(answer);
				panel.cursor = 0;
				this.host.render();
				return;
			}
			panel.phase = "safer";
			panel.saferRun = { options, cursor: 0 };
			this.host.render();
		};
		if (ask === undefined) {
			settle(null); // no provider bound — the button says so rather than lying
			return;
		}
		void Promise.resolve()
			.then(ask)
			.then(settle)
			.catch(() => settle(null));
	}

	#saferConfirm(index: number): void {
		const panel = this.#panel;
		if (panel === null || panel.saferRun === null) return;
		const { options } = panel.saferRun;
		if (index === options.length) {
			panel.phase = "options";
			panel.saferRun = null;
			panel.cursor = 0;
			this.host.render();
			return;
		}
		const chosen = options[index];
		if (chosen === undefined) return; // past the list — inert
		this.#close({ action: "deny", reason: `run this instead: ${chosen.command}` });
	}

	#saferMove(delta: -1 | 1): void {
		const panel = this.#panel;
		if (panel === null || panel.saferRun === null) return;
		const last = panel.saferRun.options.length; // + the way-back row
		panel.saferRun = { options: panel.saferRun.options, cursor: Math.max(0, Math.min(last, panel.saferRun.cursor + delta)) };
		this.host.render();
	}

	/** The amend phase: the composer becomes the denial's reason. */
	#panelAmend(): void {
		const panel = this.#panel;
		if (panel === null) return;
		panel.phase = "amend";
		this.host.clear();
		this.host.render();
	}

	#panelTab(): void {
		const panel = this.#panel;
		if (panel === null || panel.view.flavor !== "approval") return;
		panel.cursor = panelOptions(panel.view).length - 1;
		this.#panelAmend();
	}

	/** Esc walks BACK one phase before it cancels: a safer list or a
	 *  pending ask returns to the options, an amend line returns to the
	 *  options, and only the options phase itself cancels. */
	#panelEsc(): void {
		const panel = this.#panel;
		if (panel === null) return;
		if (panel.phase === "safer" || panel.phase === "asking") {
			this.#saferToken += 1;
			panel.phase = "options";
			panel.saferRun = null;
			panel.cursor = 0;
			this.host.render();
			return;
		}
		if (panel.phase !== "options") {
			panel.phase = "options";
			this.host.clear();
			this.host.render();
			return;
		}
		this.#close({ action: "cancel" });
	}

	#panelEnter(): void {
		const panel = this.#panel;
		if (panel === null) return;
		if (panel.phase === "amend") {
			this.#close({ action: "deny", reason: this.host.line() });
			return;
		}
		if (panel.phase === "safer" && panel.saferRun !== null) {
			this.#saferConfirm(panel.saferRun.cursor);
			return;
		}
		if (panel.phase === "asking") return; // nothing to confirm yet
		this.#panelConfirm(panel.cursor);
	}

	/** KC3.5: one step of the ask's walk; a phase change empties the
	 *  composer (the custom answer's text field), a result closes. */
	#askStep(key: string): void {
		const panel = this.#panel;
		if (panel === null || panel.ask === null) return;
		const spec = panel.view.ask!;
		const before = panel.ask.phase;
		const step = key === "commit" ? askCommitCustom(spec, panel.ask, this.host.expandPastes(this.host.line())) : askKey(spec, panel.ask, key);
		panel.ask = step.state;
		if (step.state.phase !== before) this.host.clear();
		if (step.result !== undefined) {
			this.#close({ action: "answers", result: step.result });
			return;
		}
		this.host.render();
	}

	#pickPanelDigit(index: number): void {
		const panel = this.#panel;
		if (panel === null || panel.pick === null) return;
		if (index < 0 || index >= Math.min(panel.view.pick!.options.length, PICK_MAX)) return;
		panel.pick = { cursor: index, phase: "options", level: startLevel(panel.view.pick!.options[index]) };
		this.host.render();
	}

	#pickPanelEnter(): void {
		const panel = this.#panel;
		if (panel === null || panel.pick === null) return;
		if (panel.pick.phase === "custom") {
			const line = this.host.line().trim();
			if (line === "") return;
			this.#close({ action: "picked", result: { custom: line } });
			return;
		}
		if (panel.view.pick!.options.length === 0) return; // nothing to take
		const level = panel.pick.level;
		this.#close({ action: "picked", result: { index: panel.pick.cursor }, ...(level === null ? {} : { level }) });
	}

	#pickPanelEsc(): void {
		const panel = this.#panel;
		if (panel === null || panel.pick === null) return;
		if (panel.pick.phase === "custom") {
			panel.pick = { cursor: panel.pick.cursor, phase: "options", level: panel.pick.level };
			this.host.clear();
			this.host.render();
			return;
		}
		this.#close({ action: "cancel" });
	}

	/** Close: the state is cleared FIRST, the stashed composer comes
	 *  back, the Enter that closed the panel is swallowed, and only then
	 *  does the verdict reach the caller — so a caller that re-enters
	 *  (a second panel, a run that resumes) never sees the closing one. */
	#close(verdict: PanelVerdict): void {
		const panel = this.#panel;
		if (panel === null) return;
		this.#panel = null;
		this.host.syncMouse();
		this.host.swallowNextEnter();
		this.host.restore(panel.stash);
		this.host.render();
		panel.onCommit(verdict);
	}
}
