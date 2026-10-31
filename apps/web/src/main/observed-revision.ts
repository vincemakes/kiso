import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { projectMessages, type Message } from "@vincemakes/kiso-core";
import type { SessionStore } from "@vincemakes/kiso-runtime";

/**
 * The hidden observed revision: with it, edit_file and write_file take no
 * expectedRevision and the file's latest `[rev:…]` is read off the
 * session's own log — what the model last observed of that file. The same
 * rule the terminal product applies (apps/cli state.ts, observedRevisionFromLog),
 * rewritten over the public store and projection instead of the log file.
 */

function real(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

export function observedRevisionFrom(store: SessionStore, workspace: string) {
	return (sessionId: string | undefined, full: string, kind: "edit" | "write" = "edit"): string | undefined => {
		if (sessionId === undefined) return undefined;
		let messages: readonly Message[];
		try {
			messages = projectMessages(store.load(sessionId).map((r) => r.event));
		} catch {
			return undefined;
		}
		const target = real(full);
		const calls = new Map<string, { readonly name: string; readonly full: string; readonly ranged: boolean }>();
		let rev: string | undefined;
		let wholeKnown = false;
		for (const m of messages) {
			if (m.role === "assistant") {
				for (const b of m.blocks) {
					if (b.type === "tool_use" && typeof b.input.path === "string") {
						calls.set(b.callId, { name: b.name, full: real(resolve(workspace, b.input.path)), ranged: b.input.offset !== undefined || b.input.limit !== undefined });
					}
				}
			} else if (m.role === "tool") {
				const c = calls.get(m.callId);
				if (c === undefined || c.full !== target) continue;
				const body = typeof m.content === "string" ? m.content : m.content.map((x) => (x.type === "text" ? x.text : "")).join("");
				const hit = [...body.matchAll(/\[(rev:[0-9a-f]{16})\]/g)].pop();
				if (hit === undefined) continue;
				if (!m.isError && (c.name === "read_file" || c.name === "edit_file" || c.name === "write_file")) {
					rev = hit[1];
					if (c.name === "read_file") wholeKnown = !c.ranged && !body.includes("(call again with offset=") && !body.includes("[output capped at");
					else if (c.name === "write_file") wholeKnown = true;
				} else if (m.isError && c.name === "edit_file" && body.includes(" changed since ")) {
					rev = hit[1];
					wholeKnown = false;
				}
			}
		}
		if (kind === "write" && !wholeKnown) return undefined;
		return rev;
	};
}
