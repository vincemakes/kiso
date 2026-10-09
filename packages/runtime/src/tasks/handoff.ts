/**
 * The handoff format (ADR-0058, 0.49.0 C3/I7): what the model reads of one
 * child, byte for byte the same whether the parent waited for it (the
 * delegate tool's section, rendered by the subagent extension) or heard of
 * it later (the group notice, rendered here). The extension carries its own
 * copy, since it has no runtime dependency. The corpus in
 * tests/fixtures/handoff holds both copies to the same expected bytes.
 *
 * The result record (result.json) commits a child's result (I5): the
 * answer (result.md) is read only beside a valid record. Without one, the
 * child's output tail is all there is (I6: nothing is inferred from its
 * session's runs).
 *
 * Budgets count UTF-8 bytes of what is shown, never the pointers:
 * the error line at most ERROR_BYTES, the tail at most TAIL_BYTES, and all
 * of it within the budget the caller passes (CHILD_HANDOFF_BYTES, or what
 * is left of GROUP_HANDOFF_BYTES).
 */

export const CHILD_HANDOFF_BYTES = 4_096;
export const GROUP_HANDOFF_BYTES = 16_384;
export const TAIL_BYTES = 2_048;
export const ERROR_BYTES = 1_024;

export interface HandoffRecord {
	readonly outcome: string;
	readonly error?: string;
}

export interface HandoffInput {
	/** result.json, parsed; null when it is absent or unreadable */
	readonly record: HandoffRecord | null;
	/** result.md's text ("" when absent) — shown only beside a record */
	readonly answer: string;
	/** the last bytes of the child's output, as read (at most TAIL_BYTES) */
	readonly tail: string;
	/** whether the output held more than `tail` */
	readonly tailCut: boolean;
	readonly resultPath: string;
}

/** The record a result.json holds, or null — the commit test (I5). */
export function handoffRecordOf(raw: string | null): HandoffRecord | null {
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw) as { outcome?: unknown; error?: unknown };
		if (typeof parsed.outcome !== "string" || parsed.outcome === "") return null;
		return typeof parsed.error === "string" && parsed.error !== "" ? { outcome: parsed.outcome, error: parsed.error } : { outcome: parsed.outcome };
	} catch {
		return null;
	}
}

/** One child's handoff body: lines each led by "\n", and the bytes shown. */
export function handoffBody(input: HandoffInput, budget: number): { readonly text: string; readonly bytes: number } {
	let text = "";
	let used = 0;
	const room = (): number => Math.max(0, budget - used);
	if (input.record?.error !== undefined) {
		const line = headOf(`error: ${input.record.error.replace(/\s*\n\s*/g, " ").trim()}`, Math.min(ERROR_BYTES, room()));
		if (line.text !== "") {
			text += `\n${line.text}${line.cut ? "…" : ""}`;
			used += Buffer.byteLength(line.text);
		}
	}
	const answer = input.record === null ? "" : input.answer.trimEnd();
	if (answer !== "") {
		if (Buffer.byteLength(answer) <= room()) return { text: `${text}\n${answer}`, bytes: used + Buffer.byteLength(answer) };
		if (room() === 0) return { text: `${text}\n[the whole answer: ${input.resultPath}]`, bytes: used };
		const cut = headOf(answer, room()).text;
		return { text: `${text}\n${cut}\n… [truncated; the whole answer: ${input.resultPath}]`, bytes: used + Buffer.byteLength(cut) };
	}
	const tail = input.tail.trimEnd();
	if (tail !== "") {
		const kept = tailOf(tail, Math.min(TAIL_BYTES, room()));
		if (kept.text !== "") {
			text += `\n${input.tailCut || kept.cut ? "…" : ""}${kept.text}`;
			used += Buffer.byteLength(kept.text);
		}
	}
	return { text, bytes: used };
}

/** The first `bytes` of `s`, never splitting a character. */
function headOf(s: string, bytes: number): { readonly text: string; readonly cut: boolean } {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= bytes) return { text: s, cut: false };
	return { text: buf.subarray(0, Math.max(0, bytes)).toString("utf8").replace(/�+$/, ""), cut: true };
}

/** The last `bytes` of `s`, never splitting a character. */
function tailOf(s: string, bytes: number): { readonly text: string; readonly cut: boolean } {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= bytes) return { text: s, cut: false };
	return { text: buf.subarray(buf.length - Math.max(0, bytes)).toString("utf8").replace(/^�+/, ""), cut: true };
}
