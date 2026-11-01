import { editDiff } from "./diff.js";
import type { Item, Step, Text } from "./model.js";

/**
 * A run's process as the stream draws it: narration and groups of steps
 * taking turns. A group is the run of steps between two narration blocks;
 * thinking goes in the group it precedes, a decided approval in the group of
 * its step. A steer or a notice stands on its own line. Pure: the proofs read
 * the same labels the page draws.
 */

export type Segment =
	| { readonly kind: "group"; readonly id: string; readonly items: readonly Item[] }
	| { readonly kind: "say"; readonly item: Text }
	| { readonly kind: "line"; readonly item: Item };

export function segmentsOf(items: readonly Item[]): Segment[] {
	const out: Segment[] = [];
	let group: Item[] | null = null;
	for (const item of items) {
		if (item.kind === "thinking" || item.kind === "step" || item.kind === "ask") {
			if (group === null) out.push({ kind: "group", id: item.id, items: (group = []) });
			group.push(item);
			continue;
		}
		group = null;
		out.push(item.kind === "text" ? { kind: "say", item } : { kind: "line", item });
	}
	return out;
}

/** The lines a step changed, only where the count is exact: a successful edit (its old and new text) or a write that created its file. */
export function delta(step: Step): { readonly added: number; readonly removed: number } | "modified" | null {
	if (step.status !== "done") return null;
	if (step.name === "edit_file") {
		const diff = editDiff(step.input);
		return diff.length === 0 ? "modified" : { added: diff.filter((l) => l.kind === "add").length, removed: diff.filter((l) => l.kind === "del").length };
	}
	if (step.name !== "write_file") return null;
	const content = step.input?.["content"];
	// a final newline ends the last line; it does not start another
	return step.output?.created === true && typeof content === "string" ? { added: content === "" ? 0 : content.replace(/\n$/, "").split("\n").length, removed: 0 } : "modified";
}

/** A group's changed lines: the sum when every change in it is exact, "modified" when one is not, null when nothing changed. */
export function groupDelta(steps: readonly Step[]): { readonly added: number; readonly removed: number } | "modified" | null {
	const all = steps.map(delta).filter((d) => d !== null);
	if (all.length === 0) return null;
	if (all.includes("modified")) return "modified";
	const exact = all.filter((d) => d !== "modified");
	return { added: exact.reduce((n, d) => n + d.added, 0), removed: exact.reduce((n, d) => n + d.removed, 0) };
}

type Phrases = Readonly<Record<string, readonly [string, string]>>;

/** What a step did, as the group line counts it: a write that created its file is a creation. */
const verbOf = (step: Step): string => (step.name === "write_file" && step.output?.created === true ? "create_file" : step.name);

/**
 * The group line: counts by verb in the order of first use ("Ran 3 commands, read a file, created a file"), past three verbs
 * "and N more actions", then "(N failed)". `phrases` holds each verb's one and many form; `{tool}` names a tool it has no words for.
 */
export function groupLabel(steps: readonly Step[], phrases: Phrases, words: { readonly more: string; readonly moreOne: string; readonly failed: string }): string {
	const counts = new Map<string, number>();
	for (const step of steps) counts.set(verbOf(step), (counts.get(verbOf(step)) ?? 0) + 1);
	const said = [...counts].slice(0, 3).map(([verb, n]) => {
		const [one, many] = phrases[verb] ?? phrases["*"]!;
		return (n === 1 ? one : many).replace("{n}", String(n)).replace("{tool}", verb);
	});
	const rest = [...counts].slice(3).reduce((sum, [, n]) => sum + n, 0);
	let text = said.join(", ");
	if (rest > 0) text += ` ${(rest === 1 ? words.moreOne : words.more).replace("{n}", String(rest))}`;
	const failed = steps.filter((s) => s.status === "failed").length;
	if (failed > 0) text += ` ${words.failed.replace("{n}", String(failed))}`;
	return text.charAt(0).toUpperCase() + text.slice(1);
}
