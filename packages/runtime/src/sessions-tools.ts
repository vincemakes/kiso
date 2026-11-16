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

/** Listing the person's own sessions reads nothing of the folder and changes nothing: allowed without asking (deny > allow >
 *  ask, so a deny earlier in the chain still wins). */
export const SESSIONS_APPROVALS: readonly ApprovalPolicy[] = [
	{ decide: (call) => (call.name === LIST_SESSIONS.name ? { action: "allow", reason: "listing the person's own sessions reads and changes nothing" } : { action: "abstain" }) },
];

/** What a twin answers in a host that cannot keep the tools' promise. */
export const SESSIONS_REFUSAL = "This needs kiso web: the session was created there and is open in the terminal now. Tell the person, or continue without it.";

/** The terminal's twins: the specs above, each refusing. */
export function refusingSessionsExtension(): KisoExtension {
	const refuse = async (): Promise<ToolResult> => ({ content: SESSIONS_REFUSAL, isError: true });
	return { name: "sessions", approvals: SESSIONS_APPROVALS, tools: [defineTool({ ...LIST_SESSIONS, execute: refuse })] };
}
