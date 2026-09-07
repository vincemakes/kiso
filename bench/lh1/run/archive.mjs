#!/usr/bin/env node
/** The immutable pair for an LH-1 leg or batch (rd1's archive.py, in mjs):
 *    <name>.tar.gz   the whole run tree, nested .git included
 *    <name>.sha256   a per-file SHA-256 manifest, sorted, plain text
 *  usage: archive.mjs <runDir> <artifactsDir> <name>
 *         archive.mjs --verify <artifactsDir> <name>   (re-hashes the tarball's entries against the manifest)
 *         archive.mjs --extract <artifactsDir> <name> <destDir> */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

function manifestLines(root) {
	const out = [];
	const walk = (dir) => {
		for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.isFile()) out.push(`${createHash("sha256").update(readFileSync(p)).digest("hex")}  ${relative(root, p)}`);
		}
	};
	walk(root);
	return out.sort((a, b) => (a.split("  ")[1] < b.split("  ")[1] ? -1 : 1));
}

export function archive(runDir, artifactsDir, name) {
	mkdirSync(artifactsDir, { recursive: true });
	const tar = join(artifactsDir, `${name}.tar.gz`);
	execFileSync("tar", ["-czf", tar, "-C", runDir, "."]);
	writeFileSync(join(artifactsDir, `${name}.sha256`), `${manifestLines(runDir).join("\n")}\n`);
	return { tar, entries: manifestLines(runDir).length, bytes: statSync(tar).size };
}

export function extract(artifactsDir, name, dest) {
	mkdirSync(dest, { recursive: true });
	execFileSync("tar", ["-xzf", join(artifactsDir, `${name}.tar.gz`), "-C", dest]);
	return dest;
}

/** Re-hash the TARBALL's entries against the manifest — proves the tracked evidence is intact from a fresh clone. */
export function verify(artifactsDir, name) {
	const tmp = mkdtempSync(join(tmpdir(), "lh1-verify-"));
	extract(artifactsDir, name, tmp);
	const recorded = readFileSync(join(artifactsDir, `${name}.sha256`), "utf8").trim().split("\n");
	const present = manifestLines(tmp);
	rmSync(tmp, { recursive: true, force: true });
	const a = new Set(recorded);
	const b = new Set(present);
	const missing = recorded.filter((l) => !b.has(l));
	const extra = present.filter((l) => !a.has(l));
	return { ok: missing.length === 0 && extra.length === 0, missing, extra, entries: recorded.length };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("archive.mjs")) {
	const [a, b, c, d] = process.argv.slice(2);
	if (a === "--verify") {
		const v = verify(b, c);
		console.log(`[lh1:archive] ${c}: ${v.ok ? "INTACT" : "DRIFTED"} (${v.entries} entries${v.ok ? "" : `; missing ${v.missing.length}, extra ${v.extra.length}`})`);
		process.exit(v.ok ? 0 : 1);
	} else if (a === "--extract") {
		extract(b, c, d);
		console.log(`[lh1:archive] extracted ${c} to ${d}`);
	} else {
		const r = archive(a, b, c);
		console.log(`[lh1:archive] ${c}: ${r.entries} entries, ${r.bytes} bytes`);
	}
}
