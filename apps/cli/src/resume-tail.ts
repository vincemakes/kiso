/**
 * REL-0152-D5 — what a resumed session shows you.
 *
 * `kiso resume <id>` printed one line naming the session and nothing
 * else, dropping the user at an empty prompt inside a conversation with
 * thousands of events. The product's claim is that a long task survives
 * interruption and you can come back to it; coming back meant being told
 * the session exists and shown none of it.
 *
 * The history is right there — the forensics in this round rebuilt an
 * entire screen from 6,581 recorded events. This projects a bounded tail
 * of it so the user can see where they were.
 *
 * A PROJECTION, never a second truth: it reads the durable log and
 * renders text. It writes nothing, decides nothing, and cannot disagree
 * with the session because it holds no state of its own.
 */

/** How much of the tail is worth showing. Two turns is enough to
 *  recognise a conversation and short enough that resuming does not
 *  bury the prompt. */
const TURNS = 2;
const REPLY_CHARS = 400;

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/**
 * The lines to print when a session is resumed — newest turn last, so it
 * reads in conversation order and the newest text sits nearest the
 * prompt. Empty when there is nothing to show, and the caller prints
 * nothing rather than an empty frame.
 */
export function resumeTail(events: readonly { readonly type: string }[], W = 80): string[] {
	const turns: { ask: string; reply: string }[] = [];
	let ask: string | null = null;
	let reply = "";
	for (const ev of events) {
		const e = ev as { type?: string; content?: unknown; text?: unknown };
		if (e.type === "user_input" && typeof e.content === "string") {
			if (ask !== null) turns.push({ ask, reply });
			ask = e.content;
			reply = "";
		} else if (e.type === "text_delta" && typeof e.text === "string" && ask !== null) {
			reply += e.text;
		}
	}
	if (ask !== null) turns.push({ ask, reply });
	const shown = turns.slice(-TURNS);
	if (shown.length === 0) return [];

	const lines: string[] = [];
	const skipped = turns.length - shown.length;
	// R2 (law 1.1): the head is the ONE rule, labelled the way every
	// other band on screen labels itself. It used to be `─ … ─`, a second
	// divider weight that existed nowhere else in the product.
	const label = skipped > 0 ? `resuming · ${turns.length} turns, showing the last ${shown.length}` : `resuming · ${turns.length} turn${turns.length === 1 ? "" : "s"}`;
	const head = `\u2500\u2500\u2500 ${label} `;
	// the cut floor is the WIDTH, never a constant: `Math.max(4, W)` let a
	// four-cell rule out at W=1..3, i.e. a chrome row wider than the
	// terminal. Every glyph here is one cell (the label is ascii plus
	// `·`), so a code-unit slice is a cell slice.
	lines.push(`${head}${"\u2500".repeat(Math.max(1, W - head.length))}`.slice(0, Math.max(1, W)));
	for (const t of shown) {
		// the human's turn keeps the quote gutter — the one glyph in the
		// product that means "these are somebody's exact words". The `\u203a`
		// it used to carry is the composer's prompt, and the composer no
		// longer has one.
		lines.push(`  \u2502 ${clip(oneLine(t.ask), 100)}`);
		const body = oneLine(t.reply);
		// A turn with no reply is a turn that was INTERRUPTED — the case
		// resume exists for. Saying so beats printing a blank line.
		lines.push(body === "" ? "    (no reply recorded — this is where it stopped)" : `    ${clip(body, REPLY_CHARS)}`);
	}
	return lines;
}
