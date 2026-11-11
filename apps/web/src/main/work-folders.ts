import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { addFolder, EnvironmentRefusedError, kisoHome, readEnvironment, removeFolder } from "@vincemakes/kiso-runtime";
import { fileStopRoots } from "@vincemakes/kiso-code/policy";
import { Refusal } from "./files.js";
import type { Space } from "./space.js";

/** The places no added folder may be, and no listing of an added folder may name (the file tools refuse them there). */
export const stopRoots = (): readonly string[] => fileStopRoots(homedir(), kisoHome());

/** A Work's added folders for the page: each with whether it still exists, and whether the list could be read at all. */
export function foldersOf(space: Space, session: string): { readonly added: readonly { readonly path: string; readonly missing: boolean }[]; readonly damaged: boolean } {
	const { added, damaged } = readEnvironment(space.dir, session);
	return { added: added.map((path) => ({ path, missing: !existsSync(path) })), damaged };
}

/** Add or remove, at any time: the file tools read the list on every call, so nothing has to be rebuilt. */
export async function changeFolders(space: Space, session: string, add: string | undefined, remove: string | undefined): Promise<void> {
	try {
		if (add !== undefined) await addFolder(space.dir, session, { primary: space.workspace, folder: add, stops: stopRoots() });
		else if (remove !== undefined) await removeFolder(space.dir, session, remove);
		else throw new Refusal(400, "add or remove a folder");
	} catch (err) {
		if (err instanceof EnvironmentRefusedError) throw new Refusal(409, err.message);
		throw err;
	}
}
