/**
 * 4c — a resumed session's history, replayed into cells.
 *
 * REL-0152-D5's tail printed the last two turns as text lines — a raw
 * block, not cells — so nothing earlier could be read, and a fold line
 * naming a key would have promised a read the product could not deliver.
 * This drives the Body's own mutations over the durable events — the same
 * calls a live run makes — so the turns render through the committed-cell
 * renderer, route B's reprint prints them again on a resize, and the
 * earlier turns sit in ONE fold row the ctrl+r viewer reads.
 *
 * Still a projection: it reads the log the session already loaded, writes
 * nothing durable, and holds no state of its own.
 *
 * The shape (owner-ruled, option A):
 *   - the last two turns in full;
 *   - every earlier turn in one fold row, "N earlier turns · ctrl+r to read";
 *   - with a compaction, the latest checkpoint in place of the fold — its
 *     summary (what the model sees next) and the turns it covers, read in
 *     the viewer — then any uncovered earlier turns folded as above.
 */

import { echoText } from "@vincemakes/kiso-tui-cells/render";
import type { TaskDeliveryItem } from "@vincemakes/kiso-core";
import { taskNoticeRow } from "./task-notice.js";

/** The Body surface the replay drives — the live run's own mutations. */
export interface ReplayBody {
	userLine(text: string): void;
	thinkingAppend(text: string): void;
	thinkingEnd(): void;
	textAppend(text: string): void;
	textEnd(): void;
	toolStart(name: string, callId: string, input: Record<string, unknown>): void;
	toolResult(callId: string, result: { content: string; isError: boolean; reason?: string | null; untimed?: boolean }): void;
	notice(text: string): void;
	endTurn(thoughtSeconds: number): void;
	fold(label: string, replay: () => void, summary?: string | null): void;
	raw(lines: string[]): void;
}

type Ev = { readonly type: string; readonly seq?: number } & Record<string, unknown>;

/** How many turns stay on screen in full. */
const FULL_TURNS = 2;

/** A user turn's opening line, or null when this input does not open one
 *  (a system-sourced input is machinery inside a turn; an empty ask is
 *  nothing). The words are the chip's words: a skill turn is the line the
 *  person typed, an image turn keeps its mark. */
function askOf(e: Ev): string | null {
	if (e.type !== "user_input" || e.source === "system") return null;
	const via = e.via as { line?: unknown } | undefined;
	const text = typeof via?.line === "string" ? via.line : echoText(e.content as Parameters<typeof echoText>[0]);
	return text.trim() === "" ? null : text;
}

/** Split events into turns: each starts at a user turn's input; anything
 *  before the first one belongs to no turn and is dropped. */
export function turnsOf(events: readonly Ev[]): Ev[][] {
	const turns: Ev[][] = [];
	for (const e of events) {
		if (askOf(e) !== null) turns.push([e]);
		else if (turns.length > 0) turns[turns.length - 1]!.push(e);
	}
	return turns;
}

/** One turn through the Body — consumeRun's mapping, minus everything that
 *  needs the live process (clocks, tailers, usage, the recap). */
function replayTurn(body: ReplayBody, turn: readonly Ev[]): void {
	let thinking = false;
	let said = false;
	const results = new Set<string>();
	for (const e of turn) {
		if (thinking && e.type !== "thinking") {
			body.thinkingEnd();
			thinking = false;
		}
		switch (e.type) {
			case "user_input": {
				const ask = askOf(e);
				if (ask !== null) body.userLine(ask);
				else if ((e.via as { kind?: unknown } | undefined)?.kind === "tasks") body.notice(taskNoticeRow((e.via as { items: readonly TaskDeliveryItem[] }).items));
				else if (e.source === "system") {
					body.notice("verification pass");
					body.notice(`  ${typeof e.content === "string" ? e.content : ""}`);
				}
				break;
			}
			case "thinking":
				if (typeof e.text === "string") {
					body.thinkingAppend(e.text);
					thinking = true;
				}
				break;
			case "tool_call_end":
				body.toolStart(String(e.name), String(e.callId), (e.input as Record<string, unknown> | undefined) ?? {});
				said = true;
				break;
			case "tool_result": {
				const text = typeof e.content === "string" ? e.content : "";
				let reason: string | null = null;
				if (((e.tags as string[] | undefined) ?? []).includes("denied")) {
					const m = /^\[Permission denied\] (.*)$/.exec(text);
					if (m !== null) reason = m[1]!;
				}
				body.toolResult(String(e.callId), { content: text, isError: e.isError === true, reason, untimed: true });
				results.add(String(e.callId));
				break;
			}
			case "text_delta":
				if (typeof e.text === "string") {
					body.textAppend(e.text);
					if (e.text.trim() !== "") said = true;
				}
				break;
			case "text_end":
				body.textEnd();
				break;
			case "model_output_abandoned":
				body.textEnd();
				body.notice("stream interrupted — the draft above is abandoned");
				break;
			default:
				break;
		}
	}
	if (thinking) body.thinkingEnd();
	body.textEnd();
	// A turn with nothing recorded after the ask is the turn that was
	// INTERRUPTED — the case resume exists for; saying so beats a blank.
	if (!said) body.notice("no reply recorded — this is where it stopped");
	body.endTurn(0);
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Replay a session's durable events into the body. Returns the number of
 * turns it found (0: a fresh session — nothing is drawn).
 */
export function replayInto(body: ReplayBody, events: readonly Ev[], W = 80): number {
	// The latest checkpoint: the turns it covers are what the model will
	// read as its summary, not as turns.
	let checkpoint: { coversToSeq: number; summary: string } | null = null;
	for (const e of events) {
		if (e.type === "summarized" && typeof e.coversToSeq === "number" && typeof e.summary === "string") checkpoint = { coversToSeq: e.coversToSeq, summary: e.summary };
	}
	const covered = checkpoint === null ? [] : turnsOf(events.filter((e) => typeof e.seq === "number" && e.seq <= checkpoint!.coversToSeq));
	const rest = turnsOf(checkpoint === null ? events : events.filter((e) => typeof e.seq !== "number" || e.seq > checkpoint!.coversToSeq));
	const total = covered.length + rest.length;
	if (total === 0) return 0;

	const shown = rest.slice(-FULL_TURNS);
	const earlier = rest.slice(0, rest.length - shown.length);
	const label = total > shown.length ? `resuming · ${plural(total, "turn")}, showing the last ${shown.length}` : `resuming · ${plural(total, "turn")}`;
	const head = `─── ${label} `;
	body.raw([`${head}${"─".repeat(Math.max(1, W - head.length))}`.slice(0, Math.max(1, W))]);

	if (checkpoint !== null) {
		const summary = checkpoint.summary;
		body.fold(`checkpoint · summarizes ${plural(covered.length, "earlier turn")} · ctrl+r to read`, () => {
			for (const t of covered) replayTurn(body, t);
		}, summary);
	}
	if (earlier.length > 0) {
		body.fold(`${plural(earlier.length, "earlier turn")} · ctrl+r to read`, () => {
			for (const t of earlier) replayTurn(body, t);
		});
	}
	for (const t of shown) replayTurn(body, t);
	return total;
}
