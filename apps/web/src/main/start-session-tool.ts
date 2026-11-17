import { basename } from "node:path";
import { defineTool, isRuntimeInput, type Event, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { readCards, readStartedBy, START_SESSION, writeCard, writeSessionName, writeStartedBy, type WorkCard } from "@vincemakes/kiso-runtime/internal";
import { forkWork } from "./fork.js";
import type { SessionsHost } from "./sessions-tool.js";
import type { Settings } from "./settings.js";
import type { Space } from "./space.js";

/**
 * ADR-0062 § 9, PR 4: `start_session`, the web host's half. The host proves who started the run the call is in, read from
 * the log, and nothing more: `asked` and `named` stand only on a run the person's own line started; any other run turns them
 * into `proposed`; a run another Work's message started is refused. `asked` starts the Work now (a `fork` waits for this run's
 * end, its cut); `named` and `proposed` draw a card the person answers (the card's state lives in this Work's sidecar).
 */

type Self = { readonly key: string; readonly sessionId: string };
type Initiation = "asked" | "named" | "proposed";

/** Who started the run now going: the first input after the last terminal. */
export function runStarter(events: readonly Event[]): "person" | "message" | "other" {
	let i = events.length - 1;
	while (i >= 0 && events[i]!.type !== "terminal") i--;
	const first = events.slice(i + 1).find((e) => e.type === "user_input");
	if (first === undefined || first.type !== "user_input") return "other";
	if (first.via?.kind === "peer") return first.via.event === "message" ? "message" : "other";
	return isRuntimeInput(first) ? "other" : "person";
}

const ok = (content: string): ToolResult => ({ content, isError: false });

export function startSessionTool(self: Self, host: SessionsHost): Tool {
	return defineTool({
		...START_SESSION,
		execute: async (raw, ctx) => {
			const input = raw as { readonly title: string; readonly brief: string; readonly initiation: Initiation; readonly context?: "fresh" | "fork" };
			const starter = runStarter(host.eventsOf(self.key, self.sessionId));
			if (starter === "message") return { content: "Refused: this turn was started by another session's message, and a message cannot start a Work. Tell the person, or message that session.", isError: true, errorKind: "precondition" };
			const initiation: Initiation = starter === "person" ? input.initiation : "proposed";
			const fork = input.context === "fork";
			if (initiation === "asked") {
				await host.startWork(self.key, self.sessionId, { title: input.title, brief: input.brief, fork, callId: ctx.callId ?? "" });
				return ok(fork ? `"${input.title}" starts when this turn ends, from this conversation.` : `Started "${input.title}". It reports back when its first turn ends.`);
			}
			writeCard(host.dirOf(self.key), self.sessionId, ctx.callId ?? "", { state: "pending", title: input.title, at: Date.now() });
			return ok(`${initiation !== input.initiation ? "This turn was not started by the person, so this is a suggestion. " : ""}A card for "${input.title}" is in front of the person; they start it, do it here, or dismiss it. Carry on with your own work.`);
		},
	});
}

export type WorkStart = { readonly title: string; readonly brief: string; readonly fork: boolean; readonly callId: string };

/** A Work's id, the shape the renderer mints (the time to the second and four random hex). */
const newWorkId = (now = new Date()): string => `${now.toISOString().slice(0, 19).replace(/:/g, "-")}-${Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")}`;

/** Start the Work: a fork of the parent at its last finished run, or a fresh one; linked to its parent, named, and run with
 *  the brief, verbatim, as its first line. The parent's card records it. */
export async function beginWork(space: Space, settings: Settings, key: string, parent: string, o: WorkStart): Promise<string> {
	const id = o.fork ? forkWork(space, settings, parent, undefined).id : newWorkId();
	if (!o.fork) settings.started(parent, id);
	writeStartedBy(space.dir, id, `${key}/${parent}`);
	writeSessionName(space.dir, id, o.title);
	writeCard(space.dir, parent, o.callId, { state: "started", title: o.title, at: Date.now(), work: id });
	await space.service.run(id, o.brief);
	return id;
}

/** The person answers a card: Start, Do it here, or dismiss. */
export async function answerCard(space: Space, settings: Settings, key: string, parent: string, callId: string, action: string): Promise<{ readonly status: number; readonly body: unknown }> {
	const card = readCards(space.dir, parent)[callId];
	if (card === undefined || card.state !== "pending") return { status: 409, body: { error: "this card is already answered" } };
	const call = space.store.load(parent).map((r) => r.event).find((e) => e.type === "tool_call_end" && e.callId === callId);
	const input = (call?.type === "tool_call_end" ? call.input : null) as { readonly brief?: string; readonly context?: string } | null;
	if (action === "dismiss" || action === "here") {
		writeCard(space.dir, parent, callId, { ...card, state: action === "here" ? "here" : "dismissed" });
		if (action === "here") await (space.service.isRunning(parent) ? Promise.resolve(space.service.steer(parent, "Do it here.")) : space.service.run(parent, "Do it here."));
		return { status: 200, body: {} };
	}
	if (action !== "start" || typeof input?.brief !== "string") return { status: 400, body: {} };
	if (input.context === "fork" && space.service.isRunning(parent)) return { status: 409, body: { error: "a fork starts from the end of this turn: wait for it to end" } };
	return { status: 200, body: { id: await beginWork(space, settings, key, parent, { title: card.title, brief: input.brief, fork: input.context === "fork", callId }) } };
}

/** What the page shows of a Work's links: who started it, and the cards its calls drew. */
export function workLinks(space: Space, session: string): { started?: { readonly parent: string; readonly folder: string }; cards: Readonly<Record<string, WorkCard>> } {
	const by = readStartedBy(space.dir, session);
	return { ...(by === null ? {} : { started: { parent: by.slice(by.lastIndexOf("/") + 1), folder: basename(space.workspace) } }), cards: readCards(space.dir, session) };
}
