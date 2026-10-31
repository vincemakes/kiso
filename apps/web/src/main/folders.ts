import { accessSync, constants, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, sep } from "node:path";
import { canonicalPath } from "@vincemakes/kiso-code/config";
import { kisoHome } from "@vincemakes/kiso-runtime";
import { Refusal } from "./files.js";
import type { DirsReply } from "../shared/files.js";

/** A folder the person picked, judged here and never trusted from the page: absolute, there, a folder, and not the kiso home or inside it. Returns its real path. */
export function validateFolder(raw: unknown): string {
	if (typeof raw !== "string" || raw === "" || raw.includes("\0") || !isAbsolute(raw)) throw new Refusal(400, "pick a folder");
	let real: string;
	try {
		real = canonicalPath(raw);
		if (!statSync(real).isDirectory()) throw new Error("not a folder");
	} catch {
		throw new Refusal(400, "that is not a folder that exists");
	}
	if (real === parse(real).root) throw new Refusal(400, "the whole disk is not a project folder");
	const home = canonicalPath(kisoHome());
	if (real === home || real.startsWith(home + sep)) throw new Refusal(400, "the kiso home holds credentials and sessions: pick a project folder");
	return real;
}

const DIRS_CAP = 500;
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/** A root of the folder browser: the home folder, or a typed absolute path that exists, is a readable folder, is not the whole disk and not the kiso home. */
function browseRoot(raw: string | null): string {
	if (raw === null || raw === "") return realpathSync(homedir());
	if (raw.includes("\0") || !isAbsolute(raw)) throw new Refusal(400, "type a full path, starting with /");
	let real: string;
	try {
		real = realpathSync(raw);
		if (!statSync(real).isDirectory()) throw new Error("not a folder");
		accessSync(real, constants.R_OK | constants.X_OK);
	} catch {
		throw new Refusal(400, "that is not a folder that exists and can be read");
	}
	if (real === parse(real).root) throw new Refusal(400, "the whole disk is not a place to browse: type a folder in it");
	if (inside(realpathSync(kisoHome()), real)) throw new Refusal(400, "the kiso home holds credentials and sessions");
	return real;
}

/**
 * One folder of the in-page folder browser: the folders in it, by name, nothing else (no files, no contents). The path is relative to
 * the root and resolved through every link; it must stay inside the root, so a link never leads the browsing out of it (such a link is
 * listed as `outside`). Dot folders and the kiso home are not listed.
 */
export function listDirs(rootRaw: string | null, rel: string): DirsReply {
	const root = browseRoot(rootRaw);
	if (rel.includes("\0") || isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Refusal(400, "a path inside the root is expected");
	let full: string;
	try {
		full = realpathSync(join(root, rel));
		if (!statSync(full).isDirectory()) throw new Error("not a folder");
	} catch {
		throw new Refusal(404, "no such folder");
	}
	const home = realpathSync(kisoHome());
	if (!inside(root, full) || inside(home, full)) throw new Refusal(403, "outside the folder you are browsing");
	const dirs: { name: string; outside?: true }[] = [];
	let entries: Dirent[];
	try {
		entries = readdirSync(full, { withFileTypes: true });
	} catch {
		throw new Refusal(403, "that folder cannot be read");
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const path = join(full, entry.name);
		if (entry.isDirectory()) {
			if (!inside(home, path)) dirs.push({ name: entry.name });
		} else if (entry.isSymbolicLink()) {
			try {
				const target = realpathSync(path);
				if (!statSync(target).isDirectory() || inside(home, target)) continue;
				dirs.push(inside(root, target) ? { name: entry.name } : { name: entry.name, outside: true });
			} catch {
				// a broken link is not a folder
			}
		}
	}
	dirs.sort((a, b) => a.name.localeCompare(b.name));
	return { root, path: relative(root, full), full, dirs: dirs.slice(0, DIRS_CAP), more: Math.max(0, dirs.length - DIRS_CAP) };
}
