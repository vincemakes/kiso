import { defineTool, type ApprovalPolicy, type KisoExtension, type ToolResult } from "@vincemakes/kiso-core";

/**
 * ADR-0062: the sessions extension's model-facing tools, one spec for both apps. The web host implements them for a Work it
 * created with the extension on; the terminal registers the same specs for such a Work, each refusing with no side effect, so
 * a model that learned the tools in the web gets a reason it can act on in the terminal, not "Unknown tool".
 */
export const LIST_SESSIONS = {
	name: "list_sessions",
	description:
		"List the person's other sessions in kiso web, across folders, most recently active first: title, short ref, folder, state (running, waiting on the person, idle, open elsewhere) and last activity. `query` keeps the ones whose title or id contains it.",
	parameters: {
		type: "object",
		properties: { query: { type: "string", description: "Part of a title or id, any case" } },
		additionalProperties: false,
	},
} as const;

export const MESSAGE = {
	name: "message",
	description:
		"Send a message to another of the person's sessions in kiso web (find it with list_sessions). It reaches that session at its next step, or wakes it if it is idle. `to` is its title or short ref. `files` are local absolute paths you may read; the receiver reads them itself. To share a result with a session that needs it, message it directly.",
	parameters: {
		type: "object",
		properties: {
			to: { type: "string", description: "The session's title or short ref, as list_sessions prints it" },
			text: { type: "string", description: "The message" },
			files: { type: "array", items: { type: "string" }, description: "Local absolute paths of files the receiver should look at" },
		},
		required: ["to", "text"],
		additionalProperties: false,
	},
} as const;

export const START_SESSION = {
	name: "start_session",
	description: [
		"Start a separate Work (a full session the person can open, talk to, steer and review) for a task of its own.",
		"Decide by one question: do you need its result before you answer this turn? Yes: use delegate. A few tool calls: do it here. It ends in something of its own (a branch, a PR, a document, a long run) and this turn does not wait: start_session. A result another session needs goes to it with message; pieces of one change, or a wide search, are delegate, not several Works.",
		'initiation: "asked" only when the person explicitly asked for a separate Work; "named" when they named a task without saying where, or asked whether one should be opened (they choose in a card); "proposed" for your own idea (a card they may start). When unsure, "named".',
		"brief: everything the new Work needs, written for a reader who has seen nothing else: the goal, the context, the deliverable and how it is accepted. It becomes the new Work's first message.",
		'context: "fork" when the new Work needs this whole conversation (it starts from the end of this turn); "fresh" otherwise.',
	].join("\n"),
	parameters: {
		type: "object",
		properties: {
			title: { type: "string", description: "A short name for the Work" },
			brief: { type: "string", description: "The new Work's first message" },
			initiation: { type: "string", enum: ["asked", "named", "proposed"] },
			context: { type: "string", enum: ["fresh", "fork"] },
		},
		required: ["title", "brief", "initiation"],
		additionalProperties: false,
	},
} as const;

/** Listing the person's own sessions reads nothing of the folder and changes nothing, and messages between them are free
 *  (owner, 2026-11-05: no permission, across folders too; the receiver's own checks govern what it then does): both are
 *  allowed without asking (deny > allow > ask, so a deny earlier in the chain still wins). */
export const SESSIONS_APPROVALS: readonly ApprovalPolicy[] = [
	{
		decide: (call) =>
			call.name === LIST_SESSIONS.name || call.name === MESSAGE.name || call.name === START_SESSION.name
				? { action: "allow", reason: "the person's own sessions: listing them, a message between them, or a Work the person asked for or decides on in a card" }
				: { action: "abstain" },
	},
];

/** What a twin answers in a host that cannot keep the tools' promise. */
export const SESSIONS_REFUSAL = "This needs kiso web: the session was created there and is open in the terminal now. Tell the person, or continue without it.";

/** The terminal's twins: the specs above, each refusing. */
export function refusingSessionsExtension(): KisoExtension {
	const refuse = async (): Promise<ToolResult> => ({ content: SESSIONS_REFUSAL, isError: true });
	return { name: "sessions", approvals: SESSIONS_APPROVALS, tools: [defineTool({ ...LIST_SESSIONS, execute: refuse }), defineTool({ ...MESSAGE, execute: refuse }), defineTool({ ...START_SESSION, execute: refuse })] };
}
