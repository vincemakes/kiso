import { changeWorkFolders, pickFolder, Refusal } from "./desk.js";
import { noteFolders } from "./envnote.js";

/** Choose a folder with the system's picker and add it to a Work; a refusal comes back in the host's words (null: added, or cancelled). */
export async function addFolderTo(key: string | null, session: string): Promise<string | null> {
	try {
		const r = await pickFolder();
		if (r.path !== undefined) (await changeWorkFolders(key, session, { add: r.path }), noteFolders(session, `added ${r.path}. Use absolute paths there.`));
		return null;
	} catch (e) {
		return e instanceof Refusal ? e.message : null;
	}
}
