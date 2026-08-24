#!/usr/bin/env node
/**
 * SH-1 ② — the control-byte gate, over RAW BYTES.
 *
 * NUL is valid UTF-8: the whitespace and CJK gates decode files and
 * therefore never saw the 0x00 that sat inside shellProgressPath's key
 * template from before the published 0.13.0 until git's binary
 * heuristic flagged a diff (the WR-1E2 commit records the exhibit).
 * This gate reads Buffers, never strings.
 *
 * Rejected: 0x00, every C0 control except \t (0x09) and \n (0x0a),
 * raw CR (0x0d — the repo is LF; .gitattributes makes checkout agree),
 * and DEL (0x7f). Exemptions are an EXPLICIT path allowlist with a
 * reason each — never a suffix class; the list is empty today.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { declaredBinary } from "./declared-binary.mjs";

/** path → reason. Deliberately empty; a future binary asset earns its
 *  row here, one file at a time, with words. */
export const BYTE_EXEMPT = {};

/** Scan one buffer; return every offending byte with its offset. */
export function scanBytes(buf) {
	const hits = [];
	for (let i = 0; i < buf.length; i += 1) {
		const b = buf[i];
		if (b === 0x09 || b === 0x0a) continue;
		if (b < 0x20 || b === 0x7f) hits.push({ byte: b, offset: i });
	}
	return hits;
}

function main() {
	const out = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" });
	const listed = out.toString("utf8").split("\0").filter(Boolean);
	// A path .gitattributes marks -text is not text. The allowlist below
	// stays for one-off text files with a defensible byte; a declared
	// binary is exempt because the REPO says it is binary, in one place.
	const binary = declaredBinary(listed);
	const files = listed.filter((f) => !binary.has(f));
	let bad = 0;
	let misdeclared = 0;

	// The escape hatch, closed: `-text` in .gitattributes exempts a path
	// from all three text gates, so a text file declared binary would go
	// silently unchecked. A declared binary must BE binary — it has to
	// contain a NUL, the same signal git's own auto-detection uses.
	for (const f of [...binary].sort()) {
		let buf;
		try {
			buf = readFileSync(f);
		} catch {
			continue;
		}
		if (!buf.includes(0)) {
			console.error(`[check-bytes] ${f} is declared -text in .gitattributes but contains no NUL — ` +
				`a text file must not be exempted from the text gates`);
			misdeclared += 1;
		}
	}

	for (const f of files) {
		if (f in BYTE_EXEMPT) continue;
		let buf;
		try {
			buf = readFileSync(f);
		} catch {
			continue; // a tracked-but-deleted path in a dirty tree is not this gate's business
		}
		const hits = scanBytes(buf);
		if (hits.length > 0) {
			bad += 1;
			const h = hits[0];
			console.error(`[check-bytes] ${f}: byte 0x${h.byte.toString(16).padStart(2, "0")} at offset ${h.offset} (${hits.length} total)`);
		}
	}
	if (misdeclared > 0) {
		console.error(`[check-bytes] RED — ${misdeclared} path(s) declared -text in .gitattributes are not binary; ` +
			`remove the row so the text gates can see them`);
	}
	if (bad > 0) {
		console.error(`[check-bytes] RED — ${bad} tracked file(s) carry control bytes outside \\t\\n`);
	}
	if (bad > 0 || misdeclared > 0) process.exit(1);
	console.log(`[check-bytes] OK — ${files.length} tracked files, no control bytes outside \\t\\n (allowlist: ${Object.keys(BYTE_EXEMPT).length})`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	main();
}
