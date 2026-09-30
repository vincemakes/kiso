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
const DESCRIPTION = [
	"Ask the human a question and wait for the answer.",
	"Use it only when you are blocked on a choice that is the human's to make",
	"(a direction, a trade-off, a preference) and the answer changes what you do next.",
	"Do not ask to confirm work you can verify, whether to proceed, for permission",
	"the human already gave (an authorization stands for the rest of the session",
	"unless its scope changes), or before an action the approval panel already gates.",
	"When a sensible default exists, take it, say which in your reply, and go on.",
	"Put every question in one call: 1-4 questions, each specific and ending in \"?\";",
	"2-4 mutually exclusive options, each a short label and a one-line trade-off;",
	"the option you recommend goes first, with \"(recommended)\" in its label.",
	"Set multiSelect when several options can be picked together.",
	"The human can always type their own answer or decline (the result then names",
	"the questions that went unanswered), so never add an \"Other\" option.",
].join(" ");

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
	// TTY gating by construction: no bridge, no tool. The extension still
	// loads (it stays countable, shadowable, disposable like the others)
	// and simply has nothing to offer a session that cannot answer.
	if (ui === undefined || ui === null || typeof ui.ask !== "function") return { name: "ask", tools: [] };
	return {
		name: "ask",
		// The approval chain: ask_user is ALLOWED by this extension, and
		// nothing else is. Requiring approval to ask a question would put
		// two panels in front of one decision — "approve asking you
		// something?" then the question itself — and the second panel can
		// already be declined, which is the same power the first one
		// offered. (The chain is deny > allow > ask — the W21/R3 ruling;
		// this comment once said "deny > ask > allow", corrected at TT-1A —
		// so this allow never overrides a user extension's DENY or plan
		// mode's read-only refusal; it does silence an earlier ask, which
		// is exactly the dont-ask-again power the ordering exists to grant.)
		approvals: [
			{
				decide: (call) =>
					call.name === "ask_user"
						? { action: "allow", reason: "asking the human is the human's own decision to make" }
						: { action: "abstain" },
			},
		],
		tools: [
			{
				name: "ask_user",
				description: DESCRIPTION,
				parameters: ASK_PARAMETERS,
				// asking again is safe — a question has no side effect
				idempotent: true,
				promptSnippet: "ask_user — put a real choice to the human (1-4 questions, 2-4 options each)",
				promptGuidelines: [
					"ask only when the human's answer changes what you do next; never ask what you can check, whether to proceed, or for permission already given",
					"with a sensible default, take it and say so; one call carries every question, the recommended option first",
				],
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
		],
	};
}

export { ASK_PARAMETERS };
