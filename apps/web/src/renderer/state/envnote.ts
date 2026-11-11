import type { WireInput } from "@vincemakes/kiso-protocol";

/** What the person changed in a Work's folders, told to the model once, before their next message (best effort, in memory only: a fact
 *  about the session, never a request; authorisation reads the list, not the conversation). The runtime keeps the block out of the title. */
const HEAD = "Environment update from kiso (a fact about this session, not a request from the person)";
const held = new Map<string, string[]>();
/** a Work is its folder's key (null: the one in use) and its id: another folder can hold a Work of the same id */
const slot = (where: string | null, session: string): string => `${where ?? ""}\0${session}`;

export const noteFolders = (where: string | null, session: string, change: string): void => void held.set(slot(where, session), [...(held.get(slot(where, session)) ?? []), change]);

/** The line with the pending update in front of it as a text block of its own (a line of blocks keeps its blocks). */
export function withNote(where: string | null, session: string, input: WireInput): WireInput {
	const lines = held.get(slot(where, session));
	if (lines === undefined) return input;
	held.delete(slot(where, session));
	return [{ type: "text", text: `${HEAD}: ${lines.join(" ")}` }, ...(typeof input === "string" ? [{ type: "text" as const, text: input }] : input)];
}
