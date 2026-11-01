// Paths gate: no machine-specific absolute path and no personal data in a tracked file of the web app (a path that works on one
// person's machine fails on the CI runner and publishes the person). Use os.tmpdir, mkdtemp, import.meta.url or an environment variable.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SELF = "scripts/gates/paths.mjs";
// built from pieces so that this file does not contain what it forbids
const word = (...parts) => parts.join("");
const FORBIDDEN = [
	[new RegExp(word("/Us", "ers/")), "a macOS home directory"],
	[new RegExp(word("/ho", "me/[a-z]")), "a Linux home directory"],
	[new RegExp(word("[A-Z]:\\\\\\\\?Us", "ers")), "a Windows home directory"],
	[new RegExp(word("/pri", "vate/(tmp|var)")), "a macOS temporary path"],
	[new RegExp(word("kiso-work", "trees")), "the owner's worktree folder"],
	[new RegExp(word("\\.claude/work", "trees")), "an agent worktree path"],
	[new RegExp(word("vi", "nve\\b")), "a personal account name"],
	[/[A-Za-z0-9._+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/, "an email address"],
];
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter((f) => f !== "" && f !== SELF);
const problems = [];
for (const file of files) {
	let lines;
	try {
		lines = readFileSync(file, "utf8").split("\n");
	} catch {
		continue;
	}
	lines.forEach((line, i) => {
		for (const [re, what] of FORBIDDEN) if (re.test(line)) problems.push(`${file}:${i + 1}: ${what}`);
	});
}
if (problems.length > 0) {
	console.error(`[paths] ${problems.length} problem(s):\n${problems.join("\n")}`);
	process.exit(1);
}
console.log(`[paths] OK: ${files.length} files hold no machine-specific path and no personal data`);
