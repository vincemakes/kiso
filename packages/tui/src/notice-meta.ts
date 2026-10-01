/**
 * Graphite §7.12 — a notice's META ROW: the label and the sentence.
 *
 * kiso's notices are sentences the CLI writes in a handful of shapes, and
 * a pipe prints them exactly as written. On a terminal each becomes a meta
 * row — a word label and the sentence beside it — so this maps the shapes
 * to their labels in ONE place, and the call sites keep their text.
 *
 * The `✦` some notices open with retires on the terminal: `✦` is the
 * turn's seal (§4), and a label says what the row is.
 */

export interface NoticeMeta {
	/** The row's label; absent for a sentence that has no kind of its own
	 *  (a command's confirmation — `mode → plan`, `[/compact] …`), which
	 *  stays whole at the content edge. `""` continues the row above. */
	readonly label?: string;
	readonly sentence: string;
}

/** kiso's session events — the notices that are a KIND of thing, first
 *  match wins. A command's own confirmation is not one of them: its words
 *  are read as a whole, and a label would only split them. */
const SHAPES: readonly (readonly [RegExp, string, (m: RegExpExecArray) => string])[] = [
	[/^✦ compacted (.*)$/s, "COMPACTED", (m) => m[1]!],
	[/^\[\/compact\] ✦ compacted(?: · )?(.*)$/s, "COMPACTED", (m) => m[1]!],
	[/^✦ pruned (.*)$/s, "PRUNED", (m) => m[1]!],
	[/^✦ window learned — (.*)$/s, "WINDOW", (m) => `learned — ${m[1]!}`],
	// the main-sync round: a background task's delivery (ADR-0058, main's
	// task-notice.ts) is a session event like the others
	[/^✦ task (.*)$/s, "TASK", (m) => m[1]!],
	[/^run failed — (.*)$/s, "FAILED", (m) => m[1]!],
	[/^(\S+) FAILED — (.*)$/s, "UNCERTAIN", (m) => `${m[1]!} — ${m[2]!}`],
	// Graphite P1b (owner, 2026-09-30): dontAsk leaves an interrupted call
	// undecided — said as what it is, and when it will be asked
	[/^\[dontAsk\] (\d+) uncertain executions? left unresolved — resolve them in an asking mode$/s, "UNCERTAIN", (m) => `${m[1]!} interrupted command${m[1] === "1" ? "" : "s"} left undecided — asked once don't ask is off`],
	// the main-sync round (owner, 2026-09-30): a call refused because the
	// don't-ask switch is on — the person set this up, so the label is dim,
	// not a failure's red
	[/^\[dontAsk\] (\S+) would ask — denied$/s, "DENIED", (m) => `${m[1]!} would ask — denied`],
	[/^(stopped at the .*-turn limit.*)$/s, "LIMIT", (m) => m[1]!],
	[/^(answer truncated at max_tokens.*)$/s, "LIMIT", (m) => m[1]!],
	[/^stream interrupted — (.*)$/s, "INTERRUPTED", (m) => m[1]!],
	[/^(no reply recorded — .*)$/s, "INTERRUPTED", (m) => m[1]!],
	[/^verification pass$/s, "VERIFY", () => ""],
];

export function noticeMeta(text: string): NoticeMeta {
	// a notice that opens with spaces continues the one above it (the
	// verification pass's content): no label of its own
	if (/^ {2}\S/.test(text)) return { label: "", sentence: text.trim() };
	for (const [re, label, sentence] of SHAPES) {
		const m = re.exec(text);
		if (m !== null) return { label, sentence: sentence(m) };
	}
	// no kind of its own: the sentence stays whole — only the `✦`, which is
	// the seal's mark on a terminal (§4), comes off
	return { sentence: text.replace(/^✦ /, "") };
}
