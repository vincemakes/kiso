import { createHash } from "node:crypto";
import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { defineTool, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import { readEnvironment, type SessionStore } from "@vincemakes/kiso-runtime";
import { completionNotice, currentChain, InboxRefusedError, MESSAGE, readStartedBy, writeMessage, type PeerFile } from "@vincemakes/kiso-runtime/internal";
import type { WorkRow } from "../shared/history.js";
import { shortRefs, type SessionsHost } from "./sessions-tool.js";

/**
 * ADR-0062 PR 2: `message`, the web host's half. `to` is resolved against the same listing `list_sessions` prints: a short
 * ref, else a title (any case), else the one title containing it; two or more matches are refused with the candidates (owner,
 * 2026-11-16, reversing spec rev 2.1's "never by title"). Files are paths the sender may read, each recorded with its
 * revision. The message is written to the receiver's inbox, then the receiver is told to look.
 */

type Self = { readonly key: string; readonly sessionId: string };

const refused = (content: string): ToolResult => ({ content, isError: true, errorKind: "precondition" });

/** The file tools' revision (`rev:` + the first 16 hex of sha256), read as a stream so a large file never sits in memory. */
const revisionOf = async (path: string): Promise<string> => {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return `rev:${hash.digest("hex").slice(0, 16)}`;
};

/** A path the sender may read: inside one of its roots (its folder, the folders it was given), never a protected file. */
export const readable = (path: string, roots: readonly string[], protectedPaths: readonly string[]): boolean => {
	// both sides through their links (a temporary folder is often reached through one): the comparison is of real places
	const real = (x: string): string => (existsSync(x) ? realpathSync(x) : resolve(x));
	const p = real(path);
	return !protectedPaths.some((x) => real(x) === p) && roots.some((r) => p === real(r) || p.startsWith(real(r) + sep));
};

const RANK: Readonly<Record<string, number>> = { plan: 0, default: 1, "accept-edits": 2, "full-access": 3 };

/** ADR-0062 § 8: whether the receiver may reach further than the sender (a wider mode, or a folder the sender was not given);
 *  what cannot be compared counts as further, so the message is held for the person. */
export const reachesFurther = (sender: { readonly tier: string; readonly added: readonly string[] }, receiver: { readonly tier: string; readonly added: readonly string[] }): boolean =>
	(RANK[receiver.tier] ?? 9) > (RANK[sender.tier] ?? -1) || receiver.added.some((f) => !sender.added.includes(f));

/** ADR-0062 § 7: after a child's run settles, the notice it owes its parent goes to the parent's inbox, and the parent looks. */
export async function notifyParent(store: SessionStore, key: string, sessionId: string, runId: string, tasksRunning: boolean, host: SessionsHost): Promise<void> {
	const parent = readStartedBy(store.root, sessionId);
	if (parent === null) return;
	const records = store.load(sessionId);
	const run = records.filter((r) => r.runId === runId).map((r) => r.event);
	const notice = completionNotice({ run, firstRun: records[0]?.runId === runId, parent, tasksRunning, waiting: false });
	if (notice === null) return;
	const from = `${key}/${sessionId}`;
	const [pKey, pId] = [parent.slice(0, parent.lastIndexOf("/")), parent.slice(parent.lastIndexOf("/") + 1)];
	const title = (await host.list()).works.find((w) => w.key === key && w.id === sessionId)?.title ?? sessionId;
	const messageId = createHash("sha256").update(`${from}\n${runId}\ncompletion`).digest("hex").slice(0, 24);
	await writeMessage(host.dirOf(pKey), pId, { messageId, from, fromTitle: title, text: `${notice.state}.${notice.excerpt === "" ? "" : `\n\n${notice.excerpt}`}`, files: [], rootId: currentChain(run, from), at: Date.now(), event: "completion" });
	await host.deliver(pKey, pId).catch(() => undefined);
}

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
			const files: PeerFile[] = [];
			for (const path of input.files ?? []) {
				if (!isAbsolute(path) || !statSync(path, { throwIfNoEntry: false })?.isFile()) return refused(`${path}: not a file (give an absolute path that exists)`);
				if (!host.mayRead(self, path)) return refused(`${path}: this session may not read it, so it cannot send it`);
				files.push({ path, rev: await revisionOf(path) });
			}
			const from = `${self.key}/${self.sessionId}`;
			// no execution id in it: a send rerun after a crash writes the same id, which the receiver takes once (ADR-0062 § 5)
			const messageId = createHash("sha256").update(`${from}\n${ctx.callId ?? ""}\n${target.key}/${target.id}\n${input.text}`).digest("hex").slice(0, 24);
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
			await host.deliver(target.key, target.id).catch(() => undefined); // not open here, or held elsewhere: it waits in the inbox
			return { content: `Sent to "${target.title}" (${target.state === "idle" ? "it will wake to read it" : "it reads it at its next step"}).`, isError: false };
		},
	});
}
