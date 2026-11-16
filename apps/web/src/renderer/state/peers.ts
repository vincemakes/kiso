/**
 * ADR-0062 § 11: a line another session sent this one, as the stream draws it: a message ("Received message from X", its text
 * when opened) or a completion notice ("X finished", the reply's opening when opened). Read from the event's own `via` and
 * the content the runtime framed for the model: the sender's title is in its quotes, the body after the first blank line; the
 * file list the model reads is not drawn (owner, 2026-11-16: files have no UI).
 */

export interface Peer {
	readonly kind: "peer";
	readonly id: string;
	readonly seq: number;
	readonly event: "message" | "completion";
	/** the sender's folder key and session id */
	readonly key: string;
	readonly session: string;
	readonly messageId: string;
	readonly title: string;
	/** a completion's end state ("finished", "failed", "waiting on you", "ended with tasks still running"); "" for a message */
	readonly state: string;
	readonly body: string;
}

type Via = { readonly kind?: unknown; readonly event?: unknown; readonly from?: unknown; readonly messageId?: unknown };

/** The peer item for an input, or null when it is not one. */
export function peerOf(seq: number, via: Via | undefined, text: string): Peer | null {
	if (via?.kind !== "peer" || typeof via.from !== "string") return null;
	const at = via.from.lastIndexOf("/");
	const title = /"([^"]*)"/.exec(text)?.[1] ?? via.from.slice(at + 1);
	let body = text.slice(text.indexOf("\n\n") + 2).replace(/\n\nFiles \(local paths; read them if you need them\):\n[\s\S]*$/, "");
	let state = "";
	if (via.event === "completion") {
		state = /^([^.\n]*)\./.exec(body)?.[1] ?? "";
		body = body.slice(state.length + 1).trim();
	}
	return { kind: "peer", id: `p${seq}`, seq, event: via.event === "completion" ? "completion" : "message", key: via.from.slice(0, at), session: via.from.slice(at + 1), messageId: String(via.messageId ?? ""), title, state, body };
}
