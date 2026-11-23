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
		"Start a separate Work (a full session the person can open, steer and review), or offer a Work card. A Work is for an independent task, not a step of the current change. A Work runs independently; it does not return a result needed to answer this turn.",
		"Decide where work belongs from the person's intent, before its size:",
		'- The person explicitly asks for a separate session or Work: initiation "asked" (it starts now).',
		'- The person asks whether to open a separate Work, or introduces another actionable, independent task while work is already underway, without assigning it to this session or an existing one: initiation "named" (a choice card), even for a small task. Do not start or do that task before the person chooses, and do not ask the same choice again through ask_user or in plain text.',
		"- Otherwise, handle the requested task here. An ordinary single request, a step of the same change, or a request assigned to this session needs no card. A passing mention is not an instruction to act. If unsure whether a task is independent, keep it here unless the person asks about separating it.",
		'- Only for a separate, self-contained deliverable you discover that the person did not ask for, you may offer initiation "proposed" (a choice card). Offer it only when separation has a clear benefit. Do not split one change or a broad search into several Works.',
		"- To notify an existing session or hand it work, use message, not start_session.",
		'brief: a standalone first message for the new Work: the goal, the context, the deliverable, the constraints and how it is accepted. With context "fresh" it cannot see this conversation.',
		"context: \"fresh\" when the brief holds what is needed; \"fork\" only when the new Work needs this conversation's history (it starts from the end of this turn).",
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

/**
 * ADR-0062 PR 1: the refs `list_sessions` prints and `message` resolves: the shortest suffix of a session id, four characters
 * at least, that no other listed id ends with; an id listed twice (two folders mint ids alone) is written `folder/id`. Keyed
 * by `folder/id`.
 */
export function shortRefs(rows: readonly { readonly id: string; readonly folder: string }[]): Map<string, string> {
	const refs = new Map<string, string>();
	const ids = rows.map((r) => r.id);
	for (const row of rows) {
		const twins = ids.filter((id) => id === row.id).length > 1;
		let n = 4;
		while (n < row.id.length && ids.some((id) => id !== row.id && id.endsWith(row.id.slice(-n)))) n += 1;
		refs.set(`${row.folder}/${row.id}`, twins ? `${row.folder}/${row.id}` : row.id.slice(-n));
	}
	return refs;
}
