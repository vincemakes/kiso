/**
 * E1 — loadExtensions: extension modules from a directory.
 *
 * Each *.mjs file's default export is a KisoExtension — or a factory
 * returning one. Loading is LOUD: a bad file, a malformed export, or a
 * duplicate extension name throws with the file name(s), so a broken
 * extension installation fails the process at startup instead of silently
 * changing behavior. An absent directory is the normal "no extensions"
 * case and yields [].
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { KisoExtension } from "@vincemakes/kiso-core";

export type { KisoExtension }; // re-exported so consumers import it from here

export async function loadExtensions(dir: string): Promise<KisoExtension[]> {
	let files: string[];
	try {
		files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return []; // no extensions dir = none installed
		throw err;
	}
	const out: KisoExtension[] = [];
	for (const file of files) {
		let ext: unknown;
		try {
			const mod = (await import(pathToFileURL(join(dir, file)).href)) as { default?: unknown };
			ext = mod.default;
			if (typeof ext === "function") ext = await ext(); // a factory
		} catch (err) {
			throw new Error(`[extensions] failed to load ${file}: ${(err as Error).message}`);
		}
		if (!isExtension(ext)) {
			throw new Error(
				`[extensions] ${file} must default-export a KisoExtension {name, hooks?, tools?, approvals?} or a factory returning one`,
			);
		}
		if (out.some((e) => e.name === ext.name)) {
			throw new Error(`[extensions] duplicate extension name "${ext.name}" in ${file}`);
		}
		out.push(ext);
	}
	return out;
}

/**
 * 发现#8 (P1): dispose every extension's external resources — each call
 * guarded (one failure never blocks the rest), each capped at 5s (a
 * timeout is abandoned and recorded — Promise.allSettled semantics).
 * Whoever LOADS extensions is responsible for disposing them.
 */
export async function disposeExtensions(extensions: readonly KisoExtension[]): Promise<void> {
	const DISPOSE_TIMEOUT_MS = 5_000;
	const settled = await Promise.allSettled(
		extensions.map(async (ext) => {
			if (ext.dispose === undefined) return;
			await Promise.race([
				Promise.resolve(ext.dispose()),
				// unref'd: a prompt dispose must not leave the abandoned cap
				// timer holding the host's event loop after the exit path.
				new Promise<void>((resolve) => setTimeout(resolve, DISPOSE_TIMEOUT_MS).unref()),
			]);
		}),
	);
	for (const r of settled) {
		if (r.status === "rejected") {
			console.error(`[extensions] ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
		}
	}
}

function isExtension(v: unknown): v is KisoExtension {
	if (typeof v !== "object" || v === null) return false;
	const e = v as { name?: unknown; hooks?: unknown; tools?: unknown; approvals?: unknown };
	return (
		typeof e.name === "string" &&
		(e.hooks === undefined || (typeof e.hooks === "object" && e.hooks !== null)) &&
		(e.tools === undefined || Array.isArray(e.tools)) &&
		(e.approvals === undefined || Array.isArray(e.approvals))
	);
}
