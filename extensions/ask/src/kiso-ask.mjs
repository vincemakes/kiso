/**
 * kiso official ASK extension (KC3.5) — the model can ask the human a
 * real question: 1-4 questions per call, 2-4 options each with optional
 * descriptions, single or multi select, a type-an-answer escape, and an
 * esc decline that RECORDS what was skipped.
 *
 * The rent is paid only where it can be earned. A headless session has
 * nobody to answer, so it never loads this extension and its tool table
 * never mentions ask_user — the factory takes the panel bridge (`ui`)
 * and the CLI passes one ONLY on the TTY path (the subagent role-policy
 * precedent: a child that cannot answer never asks). Handed no bridge,
 * the extension still loads and still contributes nothing.
 *
 * DURABILITY — zero new mechanisms. The call is durable as its
 * tool_call_end; the answers are durable as its tool_result; recovery is
 * the EXISTING ledger. `idempotent: true` is the honest declaration:
 * asking a question again is safe, because a question has no side
 * effect. (The round's ① probe pinned what the shipped recovery does
 * with an interrupted execution regardless of that flag — it asks the
 * human first, and the CLI's copy says so in the ask's own words.)
 *
 * NOT here, on purpose (the round's stop clauses): no partial-answer
 * durability — a crash mid-panel re-presents the WHOLE call, never a
 * half-filled form; no "chat about this" hand-off; no timeout, no
 * countdown, no preview pane.
 *
 * Zero runtime dependencies: the schema is data and the panel is the
 * caller's.
 */

/** The schema the L3 registry enforces — 1-4 questions, 2-4 options
 *  each, a header capped at 12 cells (the panel's title row). Every
 *  bound is real: an invalid shape is REFUSED with ajv's own message,
 *  never a crash and never a half-rendered panel. */
const ASK_PARAMETERS = {
	type: "object",
	properties: {
		questions: {
			type: "array",
			minItems: 1,
			maxItems: 4,
			items: {
				type: "object",
				properties: {
					question: { type: "string", minLength: 1 },
					header: { type: "string", maxLength: 12 },
					multiSelect: { type: "boolean" },
					options: {
						type: "array",
						minItems: 2,
						maxItems: 4,
						items: {
							type: "object",
							properties: {
								label: { type: "string", minLength: 1 },
								description: { type: "string" },
							},
							required: ["label"],
							additionalProperties: false,
						},
					},
				},
				required: ["question", "options"],
				additionalProperties: false,
			},
		},
	},
	required: ["questions"],
	additionalProperties: false,
};

// The owner's dogfood (0.40.0): a session asked "push?" after every batch,
// though delivery had been authorized once. The old text said only when to
// ask; it never said what to do INSTEAD, never named "may I proceed" or an
// authorization already given, and gave no shape for a good question. Each
// sentence below closes one of those.
// Plan B (the prefix diet): every rule above, once, in this description
// alone — the two prompt guidelines that restated it are gone.
const DESCRIPTION = [
	"Ask the human and wait, only when blocked on a choice that is theirs (direction, trade-off, preference) that changes your next step.",
	"Never ask to confirm what you can verify, whether to proceed, for an authorization already given (it stands until its scope changes), or before an action the approval panel gates.",
	"With a sensible default, take it and say so.",
	'One call: 1-4 questions ending in "?", each with 2-4 exclusive options (short label, one-line trade-off), the recommended first, marked "(recommended)"; multiSelect when several fit.',
	'No "Other" option: the human can always type an answer.',
].join(" ");

/** finish_with_choices (the decision card, plan-decision-card-2026-11-24): the non-blocking half. 2-3 labels, each the complete
 *  line that will be sent as the person's next message, the first the recommendation unless `recommended` is false. */
const FINISH_PARAMETERS = {
	type: "object",
	properties: {
		choices: { type: "array", minItems: 2, maxItems: 3, items: { type: "string", minLength: 1, maxLength: 80 } },
		recommended: { type: "boolean" },
	},
	required: ["choices"],
	additionalProperties: false,
};

const FINISH_DESCRIPTION = [
	"Finish this turn with 2-3 choices for the person: the turn ends, and the one they pick reaches you as their next message.",
	"For a direction or next-step decision that is theirs. In your closing text say what you found and, if you recommend one, which and why; the first choice must be it.",
	"Each choice is a complete line in the person's voice, at most 80 characters.",
	"If the choice is theirs alone, say so and pass recommended:false.",
	"For an answer you need before continuing, use ask_user. Never use this instead of a permission or approval gate.",
].join(" ");

/** Core's reserved tag `END_TURN` (0.42.0): a settled result carrying it completes the run with no further request. The
 *  extension has no runtime dependencies, so the constant is spelled here; core's own test pins the two together. */
const END_TURN = "end-turn";

/** The result the model reads — the answers, or the honest decline. The
 *  panel bridge produces it; this shape is the tool_result's whole
 *  content, so it is JSON and nothing else. */
function resultContent(result) {
	return JSON.stringify(result);
}

/**
 * The factory. `ui` is the panel bridge: `{ ask(spec, signal, ctx) →
 * Promise< {answers:[…]} | {declined:[…]} > }`, where `ctx` is
 * `{ sessionId, callId }` from the tool context. The CLI builds it over the
 * editor's panel slot and ignores `ctx`; a test can pass any object with
 * that one method.
 */
export default async function createAskExtension(ui) {
	// TTY gating by construction: no bridge, no tool. A host that can also draw the decision card says so (`ui.cards`); one that
	// cannot never sees finish_with_choices, so a headless run has no card nobody could click.
	const asks = ui !== undefined && ui !== null && typeof ui.ask === "function";
	const cards = ui !== undefined && ui !== null && ui.cards === true;
	if (!asks && !cards) return { name: "ask", tools: [] };
	return {
		name: "ask",
		// The approval chain: both tools are ALLOWED by this extension, and nothing else is. Requiring approval to ask a question
		// would put two panels in front of one decision (the chain is deny > allow > ask — the W21/R3 ruling), and a choice the
		// person may ignore needs none at all.
		approvals: [
			{
				decide: (call) =>
					call.name === "ask_user"
						? { action: "allow", reason: "asking the human is the human's own decision to make" }
						: call.name === "finish_with_choices"
							? { action: "allow", reason: "offering the person a choice they may ignore changes nothing" }
							: { action: "abstain" },
			},
		],
		tools: [
			...(asks
				? [
						{
							name: "ask_user",
							description: DESCRIPTION,
							parameters: ASK_PARAMETERS,
							// asking again is safe — a question has no side effect
							idempotent: true,
							promptSnippet: "ask_user — put a real choice to the human",
							execute: async (input, ctx) => {
								const questions = (input ?? {}).questions ?? [];
								// The schema already refused an empty list; this guard is
								// for direct tool use (a test, a bridge under repair).
								if (questions.length === 0) return { content: "ask_user: no questions", isError: true };
								// The third argument tells a host WHICH session and call is asking: one
								// runtime may serve many sessions, and a bridge built per runtime cannot
								// know otherwise. Both are the tool context's own values, passed through.
								const result = await ui.ask({ questions }, ctx?.signal, { sessionId: ctx?.sessionId, callId: ctx?.callId });
								return { content: resultContent(result), isError: false };
							},
						},
					]
				: []),
			...(cards
				? [
						{
							name: "finish_with_choices",
							description: FINISH_DESCRIPTION,
							parameters: FINISH_PARAMETERS,
							idempotent: true,
							promptSnippet: "finish_with_choices — end the turn with 2-3 choices for the person",
							// Nothing is asked and nothing waits: the host draws the card from this call's input and the log. The tag ends the run.
							execute: async () => ({ content: "Shown to the person; the turn ends here.", isError: false, tags: [END_TURN] }),
						},
					]
				: []),
		],
	};
}

export { ASK_PARAMETERS, FINISH_PARAMETERS };
