/**
 * Two facts a UI may read from a shell line, conservatively: literal words only, and what the reader cannot read yields nothing.
 * They are DISPLAY facts (the web page's Recent folders and Repository rows): nothing here grants or refuses anything.
 */
import { hostDialect, msysPath, parseShellLooseChecked, type LooseNode, type LooseWord } from "./shell-words.js";

const literal = (w: LooseWord | undefined): string | null => (w === undefined || w.unknownAt !== -1 || w.variableOnly ? null : w.text);

/**
 * The directories a line moves the shell to, in order, when the call that ran it did not fail: a literal `cd <path>` that is the line's first command, or
 * is reached only through `&&`, and is last or followed by `&&` (so `cd /nonexistent; echo hello`, which exits 0, makes none). Relative paths resolve against `base`, then
 * against the previous `cd`; `~` is `home`. A subshell, `||`, a pipe, an option, a variable or a line too deep to read stops the reading there.
 */
export function cdTargets(line: string, base: string, home: string): readonly string[] {
	const { nodes, truncated } = parseShellLooseChecked(line);
	if (truncated) return [];
	const out: string[] = [];
	const d = hostDialect(); // the shell's own spelling: Git Bash on Windows (`/c/x`, `C:/x`), POSIX elsewhere
	let at = base;
	for (const [i, node] of nodes.entries()) {
		if (node.kind !== "cmd" || (i > 0 && node.joinedBy !== "&&")) break;
		if (literal(node.argv[0]) !== "cd") continue;
		const next = nodes[i + 1];
		if (next !== undefined && next.joinedBy !== "&&") break; // `cd x; …` exits with what follows: only `&&`, or being last, shows the cd worked
		const raw = node.argv.length === 2 ? literal(node.argv[1]) : null;
		if (raw === null || raw === "-" || raw.startsWith("-")) break;
		const word = raw === "~" || raw.startsWith("~/") ? d.path.join(home, raw.slice(2)) : raw;
		const read = d.msys ? msysPath(word) : { native: word };
		if ("opaque" in read) break;
		at = d.path.resolve(at, read.native);
		out.push(at);
	}
	return out;
}

/** Whether the line runs `gh pr create` as a command the reader parsed (a mention in an echo or a URL in other text is not one). */
export function isGhPrCreate(line: string): boolean {
	const { nodes, truncated } = parseShellLooseChecked(line);
	if (truncated) return false;
	const walk = (ns: readonly LooseNode[]): boolean => ns.some((n) => (n.kind === "group" ? walk(n.items) : literal(n.argv[0]) === "gh" && literal(n.argv[1]) === "pr" && literal(n.argv[2]) === "create"));
	return walk(nodes);
}
