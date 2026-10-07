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

import type { NoticeMark } from "./components.js";

export interface NoticeMeta {
	/** The row's label; absent for a sentence that has no kind of its own
	 *  (a command's confirmation — `mode → plan`, `[/compact] …` without
	 *  its brackets), which stays whole at the content edge. `""`
	 *  continues the row above. */
	readonly label?: string;
	readonly sentence: string;
	/** The word the row marks, and its colour — a lost task's gold. */
	readonly mark?: NoticeMark;
	/** One row, cut with `…` — a row that names a thing (§7.12). */
	readonly oneRow?: true;
}

/** kiso's session events — the notices that are a KIND of thing, first
 *  match wins. A command's own confirmation is not one of them: its words
 *  are read as a whole, and a label would only split them. */
const SHAPES: readonly (readonly [RegExp, string | null, (m: RegExpExecArray) => string])[] = [
	[/^✦ compacted (.*)$/s, "COMPACTED", (m) => m[1]!],
	// 0.47.1 (finding 0470-F3): one round is singular on the terminal; the
	// pipe's text (`1 rounds`) is not touched
	[/^\[\/compact\] ✦ compacted(?: · )?(.*)$/s, "COMPACTED", (m) => m[1]!.replace(/^1 rounds\b/, "1 round")],
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
	// the last sweep (owner, 2026-10-06): a session switch (`/clear`,
	// `/resume <id>`) is a session event — the id it opened and the way back
	[/^session (\S+) \(switched — previous: (\S+), \/resume \S+ returns\)\n?$/s, "SESSION", (m) => `${m[1]!} · /resume ${m[2]!} returns`],
	[/^--- re-wrapped (\d+ blocks?) at the current width \(appended — the history above is unchanged\) ---$/s, "REWRAPPED", (m) => `${m[1]!} at the current width · the history above is unchanged`],
	[/^\[dontAsk\] the model's question was declined — nothing asks in dontAsk$/s, "DENIED", () => "the model's question — nothing asks while don't ask is on"],
	// …and a command's own reply. It wore its command in brackets
	// (`[/compact] …`, `[reload] …`), or brackets alone (`[no thinking
	// yet]`), or `--- … ---` rules; on the terminal the person has just
	// typed the command, so the reply is a sentence at the content edge.
	// A pipe keeps every bracket.
	[/^\[reload\] (\d+ extensions?\b.*)$/s, null, (m) => `reloaded ${m[1]!}`],
	[/^\[reload\] (.*)$/s, null, (m) => `reload failed: ${m[1]!}`],
	[/^\[\/([a-z-]+)\] failed: (.*)$/s, null, (m) => `/${m[1]!} failed: ${m[2]!}`],
	[/^\[\/[a-z-]+\] (.*)$/s, null, (m) => m[1]!],
	[/^\[(turn held — [^\]]+)\] (.*)$/s, null, (m) => `${m[1]!} · ${m[2]!}`],
	[/^\[([^[\]\n]+)\]$/s, null, (m) => m[1]!],
	[/^no such mode: (.*)\ntiers: (.*)$/s, null, (m) => `no such mode: ${m[1]!} · tiers: ${m[2]!}`],
	[/^--- (\d+ earlier blocks?) not re-wrapped \(bounded at two screens\) ---$/s, null, (m) => `${m[1]!} not re-wrapped — bounded at two screens`],
];

/** The main sync (0.46.2, Amendment 8) — a task kiso lost track of, said
 *  the moment it is concluded: `✦ lost track of <id> (<what>) — it may
 *  still be running · /tasks shows it` (the parenthesis only when the
 *  command is known; the last ` — ` opens the tail — both pinned by the
 *  line's own test). On the terminal it is the TASK row a delivery draws,
 *  `lost track — may still be running` in gold. */
const LOST = /^✦ lost track of (\S+)(?: \((.*)\))? — (it may still be running.*)$/s;

export function noticeMeta(text: string): NoticeMeta {
	const lost = LOST.exec(text);
	if (lost !== null) {
		const word = "lost track — may still be running";
		// one row, as every row that names a thing (§7.12): where to look before
		// what ran, so a cut takes the command, never the way to it
		return { label: "TASK", sentence: `${lost[1]!} ${word} · /tasks shows it${lost[2] !== undefined ? ` · ${lost[2]}` : ""}`, mark: { text: word, tone: "gold" }, oneRow: true };
	}
	// a notice that opens with spaces continues the one above it (the
	// verification pass's content): no label of its own
	if (/^ {2}\S/.test(text)) return { label: "", sentence: text.trim() };
	for (const [re, label, sentence] of SHAPES) {
		const m = re.exec(text);
		if (m !== null) return label === null ? { sentence: sentence(m) } : { label, sentence: sentence(m) };
	}
	// no kind of its own: the sentence stays whole — only the `✦`, which is
	// the seal's mark on a terminal (§4), comes off
	return { sentence: text.replace(/^✦ /, "") };
}
