#!/usr/bin/env node
/**
 * Which tracked paths does the repo DECLARE binary?
 *
 * .gitattributes has said since SH-1 that "true binaries get explicit
 * -text rows". The three text gates (whitespace, CJK, control bytes)
 * each enumerate `git ls-files` and decode every entry, which was
 * correct while the tree was text-only. RD-1B's batch archives are the
 * first tracked binaries, and they made all three fail at once —
 * gzip is full of trailing-space bytes, C0 controls, and byte pairs
 * that decode as CJK.
 *
 * Rather than give each gate its own suffix rule (which the gates
 * explicitly reject — exemptions are "never a suffix class"), they ask
 * git. One declaration in .gitattributes, honoured by every gate, and a
 * new binary asset is exempt exactly when the repo says it is binary —
 * not when three scripts happen to agree.
 */

import { execFileSync } from "node:child_process";

/** The subset of `paths` that .gitattributes marks `-text`. */
export function declaredBinary(paths) {
	if (paths.length === 0) return new Set();
	// -z keeps NUL-delimited records: path, attr, value, repeating.
	const out = execFileSync("git", ["check-attr", "-z", "--stdin", "text"], {
		input: `${paths.join("\0")}\0`,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
	const parts = out.split("\0");
	const binary = new Set();
	for (let i = 0; i + 2 < parts.length; i += 3) {
		if (parts[i + 1] === "text" && parts[i + 2] === "unset") binary.add(parts[i]);
	}
	return binary;
}
