import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { canonicalPath } from "@vincemakes/kiso-code/config";
import { kisoHome } from "@vincemakes/kiso-runtime";
import { protectedFiles } from "./agent.js";
import type { FileReply, TaskLogReply, TreeEntry, TreeReply } from "../shared/files.js";

/**
 * The read-only doors to a Work's folder, for the Files and Changes panels.
 *
 * What may be read is decided here, never by the page: a path is relative to
 * the folder's real path; it is resolved through every symbolic link and must
 * land inside the folder; the kiso home (credentials, sessions) and the
 * files the policy protects are refused even when they sit inside the folder;
 * a file is read up to a size cap and a file with a NUL byte is never read as
 * text. A link that leads outside is listed as such and never followed.
 */

export const TEXT_CAP = 256 * 1024;
export const IMAGE_CAP = 2 * 1024 * 1024;
const LIST_CAP = 500;
const LOG_CAP = 64 * 1024;
const IMAGES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** A refusal with the status the host answers. */
export class Refusal extends Error {
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

const inside = (root: string, real: string): boolean => real === root || real.startsWith(root + sep);
const folded = (name: string, dir: boolean): boolean => dir && (name === "node_modules" || name.startsWith("."));

/** Places no door reads: the kiso home and the policy's protected files, by real path. */
function protectedPaths(): { readonly dirs: readonly string[]; readonly files: readonly string[] } {
	return { dirs: [canonicalPath(kisoHome())], files: protectedFiles().map(canonicalPath) };
}

function isProtected(real: string): boolean {
	const p = protectedPaths();
	return p.dirs.some((d) => inside(d, real)) || p.files.includes(real);
}

/** The real path of `rel` inside `root` (a real path), or a Refusal. */
export function resolveInside(root: string, rel: string): string {
	if (rel.includes("\0") || isAbsolute(rel)) throw new Refusal(400, "the path must be relative to the folder");
	const target = resolve(root, rel);
	if (!inside(root, target)) throw new Refusal(403, "outside the folder");
	// a folder the listing does not open is not read through either (a dot folder can hold credentials)
	const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
	if (parts.slice(0, -1).some((p) => folded(p, true))) throw new Refusal(403, "not listed");
	let real: string;
	try {
		real = realpathSync(target);
	} catch {
		throw new Refusal(404, "no such file");
	}
	if (!inside(root, real)) throw new Refusal(403, "outside the folder");
	if (isProtected(real)) throw new Refusal(403, "protected");
	return real;
}

export function listDir(root: string, rel: string): TreeReply {
	const dir = resolveInside(root, rel);
	if (!statSync(dir).isDirectory()) throw new Refusal(400, "not a folder");
	const last = rel.split("/").filter((p) => p !== "" && p !== ".").at(-1);
	if (last !== undefined && folded(last, true)) throw new Refusal(403, "not listed");
	const entries: TreeEntry[] = [];
	let more = 0;
	const names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
	for (const ent of names) {
		const full = join(dir, ent.name);
		let real: string;
		try {
			real = realpathSync(full);
		} catch {
			continue;
		}
		if (isProtected(real)) continue;
		if (entries.length >= LIST_CAP) {
			more += 1;
			continue;
		}
		const link = lstatSync(full).isSymbolicLink();
		if (!inside(root, real)) {
			entries.push({ name: ent.name, kind: "link", size: 0, outside: true });
			continue;
		}
		const stat = statSync(real);
		const isDir = stat.isDirectory();
		entries.push({ name: ent.name, kind: link && !isDir ? "link" : isDir ? "dir" : "file", size: isDir ? 0 : stat.size, ...(folded(ent.name, isDir) ? { folded: true as const } : {}) });
	}
	return { root, path: rel, entries, more };
}

function readHead(path: string, length: number): Buffer {
	const fd = openSync(path, "r");
	try {
		const buf = Buffer.alloc(Math.min(length, fstatSync(fd).size));
		readSync(fd, buf, 0, buf.length, 0);
		return buf;
	} finally {
		closeSync(fd);
	}
}

export function readPreview(root: string, rel: string): FileReply {
	const file = resolveInside(root, rel);
	const stat = statSync(file);
	if (!stat.isFile()) throw new Refusal(400, "not a file");
	const mime = IMAGES[extname(file).toLowerCase()];
	if (mime !== undefined) return stat.size > IMAGE_CAP ? { kind: "toolarge", size: stat.size } : { kind: "image", size: stat.size, dataUrl: `data:${mime};base64,${readHead(file, IMAGE_CAP).toString("base64")}` };
	const head = readHead(file, TEXT_CAP);
	// a NUL byte in the first 8 KB: not text, however it is named
	if (head.subarray(0, 8192).includes(0)) return { kind: "binary", size: stat.size };
	const markdown = /\.(md|markdown)$/i.test(file);
	return { kind: markdown ? "markdown" : "text", size: stat.size, text: head.toString("utf8"), truncated: stat.size > TEXT_CAP };
}

/** The last part of a task's output file, as lines. */
export function readTaskLog(outputPath: string): TaskLogReply {
	try {
		const size = statSync(outputPath).size;
		const fd = openSync(outputPath, "r");
		try {
			const length = Math.min(size, LOG_CAP);
			const buf = Buffer.alloc(length);
			readSync(fd, buf, 0, length, size - length);
			return { lines: buf.toString("utf8").split("\n").filter((l, i, all) => l !== "" || i < all.length - 1), truncated: size > LOG_CAP };
		} finally {
			closeSync(fd);
		}
	} catch {
		return { lines: [], truncated: false };
	}
}
