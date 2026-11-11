import { rmSync } from "node:fs";
import { join } from "node:path";
import { Refusal } from "./files.js";
import type { Settings } from "./settings.js";
import type { Space } from "./space.js";

/**
 * The sidebar's acts on one Work. Pin and archive are the host's own memory (`desktop.json`); the log is never touched. Delete
 * removes the Work's files for good (owner ruling 2026-11-02: no trash): its log, its sidecar and its task records. Files it
 * changed in the folder stay. A Work that is running, or has a background task still running, is refused in words.
 */
export type WorkAct = "pin" | "unpin" | "archive" | "unarchive" | "delete";
export const WORK_ACTS: readonly WorkAct[] = ["pin", "unpin", "archive", "unarchive", "delete"];

export function workAct(space: Space, settings: Settings, session: string, act: WorkAct): void {
	if (!space.store.ids().includes(session)) throw new Refusal(404, "no such Work in this folder");
	if (act === "pin" || act === "unpin") return settings.mark(session, "pins", act === "pin");
	const busy = space.service.isRunning(session) ? "it is running" : space.tasks.managerFor(session).list().some((t) => t.endedAt === undefined) ? "a background task of it is still running" : null;
	if (busy !== null && act !== "unarchive") throw new Refusal(409, `${act === "delete" ? "This Work cannot be deleted" : "This Work cannot be archived"} while ${busy}: stop it first`);
	if (act === "archive" || act === "unarchive") return settings.mark(session, "archived", act === "archive");
	// closed first: the store refuses any later write to it, so nothing brings the files back
	space.store.close(session);
	space.tasks.forget(session);
	for (const path of [`${session}.jsonl`, `${session}.meta.json`, `${session}.environment.json`, `${session}.tasks`, `${session}.files`]) rmSync(join(space.dir, path), { recursive: true, force: true });
	settings.forget(session);
}
