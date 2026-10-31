/**
 * Thinking on the wire arrives as many small `thinking` deltas. The stream
 * the owner approved shows ONE line that pages to each paragraph's first
 * sentence and opens to the full text. This is that pager, as a pure
 * function over the deltas — nothing in the protocol needs to change.
 *
 *   push(text)  → what became known: a paragraph's `line` (its first
 *                 sentence, once that sentence is complete), or a closed
 *                 `paragraph` (its full text, once a blank line follows)
 *   flush()     → the open paragraph at the end of the thinking
 *
 * A paragraph ends at a blank line. Its first sentence ends at the first
 * `.`, `!` or `?` followed by whitespace, at a line break, or at the end of
 * the paragraph when none comes.
 */

export type PagerEvent =
	| { readonly kind: "line"; readonly paragraph: number; readonly text: string }
	| { readonly kind: "paragraph"; readonly paragraph: number; readonly text: string };

const SENTENCE_END = /^(.*?[.!?])\s/s;

export class ThinkingPager {
	#buf = "";
	#paragraph = 0;
	#lineSent = false;

	push(text: string): PagerEvent[] {
		this.#buf += text;
		const events: PagerEvent[] = [];
		for (;;) {
			const gap = /\n[ \t]*\n/.exec(this.#buf);
			if (gap === null) break;
			const body = this.#buf.slice(0, gap.index);
			this.#buf = this.#buf.slice(gap.index + gap[0].length);
			if (body.trim() !== "") this.#close(body, events);
		}
		this.#firstLine(events);
		return events;
	}

	flush(): PagerEvent[] {
		const events: PagerEvent[] = [];
		if (this.#buf.trim() !== "") this.#close(this.#buf, events);
		this.#buf = "";
		return events;
	}

	#firstLine(events: PagerEvent[]): void {
		if (this.#lineSent) return;
		const trimmed = this.#buf.replace(/^\s+/, "");
		const nl = trimmed.indexOf("\n");
		const m = SENTENCE_END.exec(trimmed);
		const cut = m !== null ? m[1]!.length : -1;
		const end = nl !== -1 && (cut === -1 || nl < cut) ? nl : cut;
		if (end !== -1 && end > 0) {
			this.#lineSent = true;
			events.push({ kind: "line", paragraph: this.#paragraph, text: trimmed.slice(0, end).trim() });
		}
	}

	#close(body: string, events: PagerEvent[]): void {
		if (!this.#lineSent) {
			// a short paragraph with no sentence end: its whole text is its line
			events.push({ kind: "line", paragraph: this.#paragraph, text: body.trim().split("\n")[0]!.trim() });
		}
		events.push({ kind: "paragraph", paragraph: this.#paragraph, text: body.trim() });
		this.#paragraph += 1;
		this.#lineSent = false;
	}
}
