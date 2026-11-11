/**
 * Two facts a UI may read from a shell line, conservatively: literal words only, and what the reader cannot read yields nothing.
 * They are DISPLAY facts (the web page's Recent folders and Repository rows): nothing here grants or refuses anything.
 */
import { hostDialect, msysPath, parseShellLooseChecked, type LooseCommand, type LooseWord } from "./shell-words.js";

const literal = (w: LooseWord | undefined): string | null => (w === undefined || w.unknownAt !== -1 || w.variableOnly ? null : w.text);

/** The commands of a line that is ONE `&&` chain (no `||`, `;`, pipe or group anywhere), or null: only then did every command run when the call did not fail. */
function chainOf(line: string): readonly LooseCommand[] | null {
	const { nodes, truncated } = parseShellLooseChecked(line);
	if (truncated || nodes.some((n, i) => n.kind !== "cmd" || (i > 0 && n.joinedBy !== "&&"))) return null;
	return nodes as readonly LooseCommand[];
}

/**
 * The directories a line moves the shell to, in order, when the call that ran it did not fail: the literal `cd <path>` commands of a line
 * that is one `&&` chain, so every one of them ran (`cd /nonexistent; echo hello` exits 0 without having moved, and so does
 * `false && cd /x && ls || true`). Relative paths resolve against `base`, then against the previous `cd`; `~` is `home`. An option, a
 * variable or a word the host's shell cannot spell stops the reading there.
 */
export function cdTargets(line: string, base: string, home: string): readonly string[] {
	const chain = chainOf(line);
	if (chain === null) return [];
	const out: string[] = [];
	const d = hostDialect(); // the shell's own spelling: Git Bash on Windows (`/c/x`, `C:/x`), POSIX elsewhere
	let at = base;
	for (const cmd of chain) {
		if (literal(cmd.argv[0]) !== "cd") continue;
		const raw = cmd.argv.length === 2 ? literal(cmd.argv[1]) : null;
		if (raw === null || raw === "-" || raw.startsWith("-")) break;
		const word = raw === "~" || raw.startsWith("~/") ? d.path.join(home, raw.slice(2)) : raw;
		const read = d.msys ? msysPath(word) : { native: word };
		if ("opaque" in read) break;
		at = d.path.resolve(at, read.native);
		out.push(at);
	}
	return out;
}

/** Whether the line runs `gh pr create` as a command of one `&&` chain (a mention in an echo, or a `||` branch that may not have run, is not one). */
export function isGhPrCreate(line: string): boolean {
	return (chainOf(line) ?? []).some((c) => literal(c.argv[0]) === "gh" && literal(c.argv[1]) === "pr" && literal(c.argv[2]) === "create");
}
