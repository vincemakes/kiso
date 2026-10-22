/**
 * The desktop's own frames — what the host adds beside the wire events on
 * the same stream (`event: <name>` without an `id:`). None of them is
 * durable: a reconnecting client is replayed the wire events and gets the
 * frames of the events it missed again, and `tasks` afresh.
 */

/** One call's usage as the log states it, canonical (fresh-only input). */
export interface UsageNumbers {
	readonly fresh: number | null;
	readonly output: number | null;
	readonly cacheRead: number | null;
	readonly known: boolean;
}

/** `event: usage` — beside each durable `usage` event. `turn` is the run so
 *  far: settled calls plus the latest report of the call in flight. */
export interface UsageFrame {
	readonly seq: number;
	readonly call: UsageNumbers;
	readonly turn: UsageNumbers & { readonly cacheRate: number | null; readonly calls: number };
}

/** `event: tool_output` — beside each durable `tool_result`: the part of the
 *  result a card draws. The wire's `tool_result` carries no content. */
export interface ToolOutputFrame {
	readonly seq: number;
	readonly callId: string;
	readonly isError: boolean;
	readonly head: readonly string[];
	readonly lines: number;
	readonly bytes: number;
	readonly truncated: boolean;
}

/** One background task as a card or the rail draws it. */
export interface TaskRow {
	readonly id: string;
	readonly label: string;
	readonly command: string;
	readonly startedAt: number;
	readonly endedAt: number | null;
	readonly elapsedMs: number;
}

/** `event: tasks` — pushed when the set or a state changes (not durable). */
export interface TasksFrame {
	readonly at: number;
	readonly tasks: readonly TaskRow[];
}

/** cache / (fresh + cache), as a percentage; null when unmeasured. */
export function cacheRate(fresh: number | null, cache: number | null): number | null {
	if (fresh === null || cache === null) return null;
	const total = fresh + cache;
	return total > 0 ? (cache / total) * 100 : null;
}
