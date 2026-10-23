import { parentPort } from "node:worker_threads";
import { SessionStore } from "@vincemakes/kiso-runtime";

/**
 * Lists one session folder off the host's thread: `SessionStore.list()` reads
 * every log whole to title it, and one folder of long sessions takes seconds.
 * Message in: `{ dir }`. Message out: `{ dir, metas }` or `{ dir, error }`.
 */

parentPort!.on("message", (message: { readonly dir: string }) => {
	try {
		const store = new SessionStore(message.dir);
		const metas = store.list();
		store.closeAll();
		parentPort!.postMessage({ dir: message.dir, metas });
	} catch (error) {
		parentPort!.postMessage({ dir: message.dir, error: error instanceof Error ? error.message : String(error) });
	}
});
