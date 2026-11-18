import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { defineTool, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { readEnvironment, type SessionStore } from "@vincemakes/kiso-runtime";
import { completionMessage, currentChain, fileRevision, InboxRefusedError, readInbox, peerMessageId, reachesFurther, MESSAGE, readForkOrigin, readStartedBy, retriedSendCallId, shortRefs, writeMessage, type PeerFile } from "@vincemakes/kiso-runtime/internal";
import type { WorkRow } from "../shared/history.js";
import type { SessionsHost } from "./sessions-tool.js";

/**
 * ADR-0062 PR 2: `message`, the web host's half. `to` is resolved against the same listing `list_sessions` prints: a short
 * ref, else a title (any case), else the one title containing it; two or more matches are refused with the candidates (owner,
 * 2026-11-16, reversing spec rev 2.1's "never by title"). Files are paths the sender may read, each recorded with its
 * revision. The message is written to the receiver's inbox, then the receiver is told to look.
 */

type Self = { readonly key: string; readonly sessionId: string };

const refused = (content: string): ToolResult => ({ content, isError: true, errorKind: "precondition" });
const WENT = {
	handed: "it is running and reads it at its next step.",
	woke: "it was idle and woke to read it.",
	waiting: "it is idle and was not woken (this chain's wake budget is spent); it reads it when it next runs.",
	elsewhere: "it is open elsewhere (the terminal), so it is not running here; the message waits in its inbox until kiso web opens it.",
} as const;

/** A path the sender may read: inside one of its roots (its folder, the folders it was given), never a protected file. */
export const readable = (path: string, roots: readonly string[], protectedPaths: readonly string[]): boolean => {
	// both sides through their links (a temporary folder is often reached through one): the comparison is of real places
	const real = (x: string): string => (existsSync(x) ? realpathSync(x) : resolve(x));
	const p = real(path);
	return !protectedPaths.some((x) => real(x) === p) && roots.some((r) => p === real(r) || p.startsWith(real(r) + sep));
};

/** ADR-0062 § 7: after a child's run settles, the notice it owes its parent goes to the parent's inbox, and the parent looks. */
export async function notifyParent(store: SessionStore, key: string, sessionId: string, runId: string, tasksRunning: boolean, host: SessionsHost): Promise<void> {
	const parent = readStartedBy(store.root, sessionId);
	if (parent === null) return;
	const [pKey, pId] = [parent.slice(0, parent.lastIndexOf("/")), parent.slice(parent.lastIndexOf("/") + 1)];
	if (!existsSync(join(host.dirOf(pKey), `${pId}.meta.json`))) return; // the parent was deleted: nothing is sent, and nothing of it is made again
	const fromTitle = (await host.list()).works.find((w) => w.key === key && w.id === sessionId)?.title ?? sessionId;
	const forkAfterSeq = readForkOrigin(store.root, sessionId)?.afterSeq; // a fork opens on the parent's runs
	const notice = completionMessage({ records: store.load(sessionId), runId, from: `${key}/${sessionId}`, fromTitle, parent, tasksRunning, ...(forkAfterSeq !== undefined ? { forkAfterSeq } : {}) });
	if (notice === null) return;
	await writeMessage(host.dirOf(pKey), pId, notice);
	await host.deliver(pKey, pId).catch(() => undefined);
}

/** ADR-0062 § 8: whether a message waits in the Work's inbox for the person to admit it. */
export const holdsHeld = (dir: string, sessionId: string): boolean => readInbox(dir, sessionId).some((m) => m.held === true);

/** The chain a Work is on, from its log. */
export const chainIn = (store: SessionStore, key: string, sessionId: string): string => currentChain(store.load(sessionId).map((r) => r.event), `${key}/${sessionId}`);

/** The one Work `to` names among the others, or why not. */
export function resolveTo(rows: readonly WorkRow[], to: string): WorkRow | string {
	const refs = shortRefs(rows);
	const t = to.trim().toLowerCase();
	const byRef = rows.filter((w) => refs.get(`${w.folder}/${w.id}`)?.toLowerCase() === t || w.id.toLowerCase() === t);
	const byTitle = rows.filter((w) => w.title.trim().toLowerCase() === t);
	const found = byRef.length > 0 ? byRef : byTitle.length > 0 ? byTitle : rows.filter((w) => t !== "" && w.title.toLowerCase().includes(t));
	if (found.length === 1) return found[0]!;
	if (found.length === 0) return `No session is called "${to}". Call list_sessions to see their titles and refs.`;
	return `"${to}" names ${found.length} sessions; use a ref:\n${found.slice(0, 10).map((w) => `- ${w.title} · ref ${refs.get(`${w.folder}/${w.id}`)} · folder ${w.folder}`).join("\n")}`;
}

export function messageTool(self: Self, host: SessionsHost): Tool {
	return defineTool({
		...MESSAGE,
		execute: async (raw, ctx) => {
			const input = raw as { readonly to: string; readonly text: string; readonly files?: readonly string[] };
			const reply = await host.list();
			const others = reply.works.filter((w) => !(w.key === self.key && w.id === self.sessionId));
			const target = resolveTo(others, input.to);
			if (typeof target === "string") return refused(target);
			if (!existsSync(join(host.dirOf(target.key), `${target.id}.meta.json`))) return refused(`"${target.title}" no longer exists. Call list_sessions to see the current sessions.`);
			const files: PeerFile[] = [];
			for (const given of input.files ?? []) {
				const cwd = host.cwdOf(self.key) ?? "";
				const path = isAbsolute(given) ? given : resolve(cwd, given); // a relative path is the sender's folder's
				if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return refused(`${given}: not a file (relative paths are read from ${cwd}; give a file that exists)`);
				if (!host.mayRead(self, path)) return refused(`${path}: this session may not read it, so it cannot send it`);
				files.push({ path, rev: await fileRevision(path) });
			}
			const from = `${self.key}/${self.sessionId}`;
			// a send the crash rerun cut off takes that call's id, so the receiver takes it once (ADR-0062 § 5)
			const messageId = peerMessageId(from, retriedSendCallId(host.eventsOf(self.key, self.sessionId), input) ?? ctx.callId ?? "", `${target.key}/${target.id}`, input.text);
			const reach = (key: string, id: string) => ({ tier: host.tierOf(id), added: readEnvironment(host.dirOf(key), id).added });
			const held = reachesFurther(reach(self.key, self.sessionId), reach(target.key, target.id));
			const fromTitle = reply.works.find((w) => w.key === self.key && w.id === self.sessionId)?.title ?? self.sessionId;
			try {
				await writeMessage(host.dirOf(target.key), target.id, { messageId, from, fromTitle, text: input.text, files, rootId: host.chainOf(self.key, self.sessionId), at: Date.now(), ...(held ? { held: true as const } : {}) });
			} catch (err) {
				if (err instanceof InboxRefusedError) return refused(err.message);
				throw err;
			}
			if (held) return { content: `Sent to "${target.title}", held for the person: that session may do more than this one, so they admit it first.`, isError: false };
			// what became of it, so the model knows whether to wait for a reply: a Work another process holds cannot be opened here
			const went = await host.deliver(target.key, target.id).catch(() => "elsewhere" as const);
			return { content: `Sent to "${target.title}": ${WENT[went]}`, isError: false };
		},
	});
}
