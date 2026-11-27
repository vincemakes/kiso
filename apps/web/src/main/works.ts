import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nameOf, subtreeOf } from "./names.js";
import { Refusal } from "./files.js";
import type { Settings } from "./settings.js";
import type { Space } from "./space.js";

/**
 * The sidebar's acts on one Work. Pin and archive are the host's own memory (`desktop.json`); the log is never touched. Delete
 * removes the Work's files for good (owner ruling 2026-11-02: no trash): its log, its sidecar, its task records and its request trace. Files it
 * changed in the folder stay. A Work that is running, or has a background task still running, is refused in words.
 */
export type WorkAct = "pin" | "unpin" | "archive" | "unarchive" | "delete" | "delete-tree";
export const WORK_ACTS: readonly WorkAct[] = ["pin", "unpin", "archive", "unarchive", "delete", "delete-tree"];

const busyOf = (space: Space, id: string): string | null => (space.service.isRunning(id) ? "it is running" : space.tasks.managerFor(id).list().some((t) => t.endedAt === undefined) ? "a background task of it is still running" : null);

/** Everything a Work leaves: closed first (the store refuses any later write to it, so nothing brings the files back). */
async function remove(space: Space, settings: Settings, session: string): Promise<void> {
	settings.bury(space.key, session); // first: from here on nothing opens it again, not even a read
	// then its sidecar, before the close is awaited: every writer that asks whether a Work still exists (a child's completion notice,
	// the message tool) reads it as gone from here, so nothing writes into it during the close and is left behind
	rmSync(join(space.dir, `${session}.meta.json`), { force: true });
	await space.store.close(session); // the barrier: no write or sync of it is in flight once this returns
	space.tasks.forget(session);
	for (const path of filesOf(session)) rmSync(join(space.dir, path), { recursive: true, force: true });
	settings.forget(session);
}

/** A Work's files in its folder, as a delete removes them (the log first: a Work without one is no longer listed). */
const filesOf = (session: string): string[] => [`${session}.jsonl`, `${session}.lock`, `${session}.meta.json`, `${session}.environment.json`, `${session}.environment.json.lock`, `${session}.inbox`, `${session}.tasks`, `${session}.files`, join("traces", `${session}.jsonl`)];

/**
 * #21 (and #28): a delete that a kill cut short (the tombstone written, some files not yet removed) is finished when the folder is
 * next opened, before anything reads it. Only tombstoned ids; one whose sidecar exists again is left alone (a Work something opened
 * since is never touched). Idempotent: an id with nothing left and nothing remembered costs one look. The ids it finished.
 */
export function sweepBuried(dir: string, key: string, settings: Settings): string[] {
	const swept: string[] = [];
	for (const session of settings.buriedIn(key)) {
		if (existsSync(join(dir, `${session}.meta.json`))) continue;
		const left = filesOf(session).filter((path) => existsSync(join(dir, path)));
		if (left.length === 0 && !settings.remembers(session)) continue;
		for (const path of left) rmSync(join(dir, path), { recursive: true, force: true });
		settings.forget(session);
		swept.push(session);
	}
	return swept;
}

export async function workAct(space: Space, settings: Settings, session: string, act: WorkAct): Promise<void> {
	if (!space.store.ids().includes(session)) throw new Refusal(404, "no such Work in this folder");
	if (act === "pin" || act === "unpin") return settings.mark(session, "pins", act === "pin");
	if (act === "delete-tree") {
		// the whole tree is checked before anything is removed: one running member refuses all of it
		const tree = subtreeOf(space.dir, space.key, space.store.ids(), session);
		for (const id of tree) {
			const why = busyOf(space, id);
			if (why !== null) throw new Refusal(409, `\u201c${nameOf(space.dir, id)}\u201d cannot be deleted while ${why}: stop it first. Nothing was deleted.`);
		}
		for (const id of [...tree].reverse()) await remove(space, settings, id);
		return;
	}
	const busy = busyOf(space, session);
	if (busy !== null && act !== "unarchive") throw new Refusal(409, `${act === "delete" ? "This Work cannot be deleted" : "This Work cannot be archived"} while ${busy}: stop it first`);
	if (act === "archive" || act === "unarchive") return settings.mark(session, "archived", act === "archive");
	await remove(space, settings, session);
}
