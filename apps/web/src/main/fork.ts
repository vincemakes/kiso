import { ForkRefusedError } from "@vincemakes/kiso-runtime";
import { Refusal } from "./files.js";
import type { Fork, Settings } from "./settings.js";
import type { Space } from "./space.js";

/**
 * Fork a Work: the runtime's SessionStore.fork (one rule for the terminal, the web app and the products, plan fork rev 2),
 * after the run that ended at `atSeq` (absent: the last). The runtime copies the log to that run's end, writes the fork's
 * sidecar (the parent's profile, "… (fork)", its origin) and gives the fork note to the model with the fork's first input,
 * after the copied history: never in the system prompt, where it cost the fork's first request the whole history's cache
 * (0% against 88% measured on co). The host still remembers the lineage for the forks it made before.
 */
export function forkWork(space: Space, settings: Settings, parent: string, atSeq: number | undefined): { readonly id: string; readonly fork: Fork } {
	if (!space.store.ids().includes(parent)) throw new Refusal(404, "no such Work in this folder");
	let made: ReturnType<Space["store"]["fork"]>;
	try {
		made = space.store.fork(parent, atSeq === undefined ? {} : { afterSeq: atSeq });
	} catch (error) {
		if (error instanceof ForkRefusedError) throw new Refusal(409, error.message.replace(/session/g, "Work"));
		throw error;
	}
	const fork: Fork = { parent, title: made.origin.title, atSeq: made.origin.afterSeq, at: made.origin.at };
	settings.forked(parent, made.id, fork);
	return { id: made.id, fork };
}
