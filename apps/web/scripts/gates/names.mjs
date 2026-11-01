// Names gate: no private product name and no competitor name anywhere in the web app's tracked files. The names are held
// as hashes (the first 16 hex digits of the SHA-256 of the lowercase token), so this file does not contain what it forbids.
// To add a name: printf '%s' name | shasum -a 256 | cut -c1-16
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const FORBIDDEN = new Set(["c68b92acc3813fa2", "f8a1f94dca32469a", "854f31467f4631b7", "4bc189edffe6e3fb", "ec033857803e565c", "5cd5c98298b09cc0", "62f8e1ec095e1857", "5d0c0ab127fdea24", "57de4cf40144bdf7", "ebde709e306badca", "84829dbd81531188", "3ea125d0bff386e6", "ead627e2b11190fd"]);
const hash = (token) => createHash("sha256").update(token).digest("hex").slice(0, 16);

/** Every way a name can be written: whole words, hyphen or underscore parts, camelCase parts. */
function tokens(line) {
	const out = new Set();
	for (const word of line.match(/[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)*/g) ?? []) {
		out.add(word.toLowerCase());
		for (const part of word.split(/[-_]/)) out.add(part.toLowerCase());
		for (const part of word.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? []) out.add(part.toLowerCase());
	}
	return out;
}

const problems = [];
const files = execFileSync("git", ["ls-files", "--", ".", ":!package-lock.json"], { encoding: "utf8" }).split("\n").filter((f) => f !== "");
for (const file of files) {
	let lines;
	try {
		lines = readFileSync(file, "utf8").split("\n");
	} catch {
		continue;
	}
	lines.forEach((line, i) => {
		for (const token of tokens(line)) if (FORBIDDEN.has(hash(token))) problems.push(`${file}:${i + 1}: names "${token}"`);
	});
}
if (problems.length > 0) {
	console.error(`[names] ${problems.length} problem(s):\n${problems.join("\n")}`);
	process.exit(1);
}
console.log(`[names] OK: ${files.length} files name no private product and no competitor`);
