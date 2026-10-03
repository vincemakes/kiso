/**
 * The shell command line, READ — never run — for the approval chain
 * (0.40.0: the read-only allow now, the catastrophe floor next).
 *
 * This is not a shell. It is a lexer for the subset of POSIX sh whose
 * meaning can be known WITHOUT running anything, and it refuses the rest:
 * a command line that uses expansion (`$`, backticks, globs, a leading
 * `~`, braces), grouping or subshells, background jobs, heredocs, or a
 * leading variable assignment does not parse, and a caller that cannot
 * parse a line must treat it as unknown. The refusals are the design —
 * every construct accepted here is one whose words are exactly the words
 * the shell will pass to the program.
 *
 * What it produces is a LIST of pipelines joined by `;`, `&&`, `||` (a
 * newline counts as `;`), each pipeline a series of simple commands joined
 * by `|`, each command an argv plus its redirections.
 */

import { existsSync, realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

export interface Redirect {
	/** The descriptor written before the operator (`2>`), null when none
	 *  was written, or "&" for `&>` (stdout and stderr together). */
	readonly fd: number | "&" | null;
	readonly op: ">" | ">>" | "<" | ">&";
	readonly target: string;
}

export interface SimpleCommand {
	readonly argv: readonly string[];
	readonly redirects: readonly Redirect[];
}

export interface Pipeline {
	/** How this pipeline joins the one before it; null for the first. */
	readonly joinedBy: ";" | "&&" | "||" | null;
	readonly stages: readonly SimpleCommand[];
}

export type ParseResult = { readonly ok: true; readonly list: readonly Pipeline[] } | { readonly ok: false; readonly why: string };

const GLOB = new Set(["*", "?", "["]);

/**
 * Parse a command line, or say why not. Pure: no filesystem, no
 * environment.
 */
export function parseShell(src: string): ParseResult {
	const list: Pipeline[] = [];
	let stages: SimpleCommand[] = [];
	let argv: string[] = [];
	let redirects: Redirect[] = [];
	let joinedBy: Pipeline["joinedBy"] = null;
	// The word being built, and whether any of it has been seen yet — an
	// empty quoted string `''` is a word, an empty buffer is not.
	let word = "";
	let inWord = false;
	let wordQuoted = false;
	// Where in `word` the first quoted character sits: an assignment is
	// `NAME=` written UNQUOTED, so `FOO="x" cmd` is one and `"FOO=x" cmd`
	// is not.
	let quotedFrom = Number.POSITIVE_INFINITY;
	// A redirection operator waiting for its target word.
	let pending: { fd: Redirect["fd"]; op: Redirect["op"] } | null = null;

	const fail = (why: string): ParseResult => ({ ok: false, why });

	const endWord = (): string | null => {
		if (!inWord) return null;
		const w = word;
		if (pending !== null) {
			redirects.push({ fd: pending.fd, op: pending.op, target: w });
			pending = null;
		} else {
			const assign = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(w);
			if (argv.length === 0 && assign !== null && assign[0].length <= quotedFrom) return "a leading variable assignment";
			argv.push(w);
		}
		word = "";
		inWord = false;
		wordQuoted = false;
		quotedFrom = Number.POSITIVE_INFINITY;
		return null;
	};
	const endCommand = (): string | null => {
		if (pending !== null) return "a redirection with no target";
		if (argv.length === 0) return redirects.length > 0 ? "a redirection with no command" : "an empty command";
		stages.push({ argv, redirects });
		argv = [];
		redirects = [];
		return null;
	};
	const endPipeline = (next: Pipeline["joinedBy"]): string | null => {
		const e = endCommand();
		if (e !== null) return e;
		list.push({ joinedBy, stages });
		stages = [];
		joinedBy = next;
		return null;
	};

	let i = 0;
	const n = src.length;
	while (i < n) {
		const c = src[i]!;
		// ── quoting ──────────────────────────────────────────────────────
		if (c === "'") {
			const end = src.indexOf("'", i + 1);
			if (end < 0) return fail("an unterminated single quote");
			quotedFrom = Math.min(quotedFrom, word.length);
			word += src.slice(i + 1, end);
			inWord = true;
			wordQuoted = true;
			i = end + 1;
			continue;
		}
		if (c === '"') {
			quotedFrom = Math.min(quotedFrom, word.length);
			let j = i + 1;
			let closed = false;
			while (j < n) {
				const d = src[j]!;
				if (d === '"') {
					closed = true;
					break;
				}
				if (d === "$" || d === "`") return fail("an expansion inside double quotes");
				if (d === "\\" && j + 1 < n && '$`"\\\n'.includes(src[j + 1]!)) {
					if (src[j + 1] !== "\n") word += src[j + 1];
					j += 2;
					continue;
				}
				word += d;
				j += 1;
			}
			if (!closed) return fail("an unterminated double quote");
			inWord = true;
			wordQuoted = true;
			i = j + 1;
			continue;
		}
		if (c === "\\") {
			if (i + 1 >= n) return fail("a trailing backslash");
			if (src[i + 1] !== "\n") {
				quotedFrom = Math.min(quotedFrom, word.length);
				word += src[i + 1];
				inWord = true;
				wordQuoted = true;
			}
			i += 2;
			continue;
		}
		// ── what this reader refuses ─────────────────────────────────────
		if (c === "$" || c === "`") return fail("an expansion");
		if (c === "(" || c === ")") return fail("a subshell or grouping");
		// A brace EXPANDS only as `{a,b}` or `{a..b}`; anything else is a
		// character (`HEAD@{u}`, `@{1}`). A `{` or `}` standing alone as a
		// word is a group, which this reader refuses.
		if (c === "{") {
			const close = src.indexOf("}", i + 1);
			const body = close < 0 ? "" : src.slice(i + 1, close);
			if (close < 0 || !inWord || /[\s;&|(){}<>]/.test(body) || body.includes(",") || body.includes("..")) return fail("a brace");
			word += src.slice(i, close + 1);
			i = close + 1;
			continue;
		}
		if (c === "}") return fail("a brace");
		if (GLOB.has(c)) return fail("a glob");
		// A tilde expands at the start of a word and, in bash, after the `=`
		// or `:` of anything shaped like an assignment (`--prefix=~/x`). In
		// the middle of a word it is a character (`HEAD~3`).
		if (c === "~" && (!inWord || word.endsWith("=") || word.endsWith(":"))) return fail("a tilde");
		if (c === "#" && !inWord) return fail("a comment");
		// ── separators and operators ─────────────────────────────────────
		if (c === " " || c === "\t") {
			const e = endWord();
			if (e !== null) return fail(e);
			i += 1;
			continue;
		}
		if (c === "\n" || c === ";") {
			if (c === ";" && src[i + 1] === ";") return fail("a case terminator");
			const e = endWord() ?? endPipeline(";");
			if (e !== null) return fail(e);
			i += 1;
			continue;
		}
		if (c === "|") {
			if (src[i + 1] === "&") return fail("a |& pipe");
			const e = endWord();
			if (e !== null) return fail(e);
			if (src[i + 1] === "|") {
				const f = endPipeline("||");
				if (f !== null) return fail(f);
				i += 2;
				continue;
			}
			const f = endCommand();
			if (f !== null) return fail(f);
			i += 1;
			continue;
		}
		if (c === "&") {
			if (src[i + 1] === "&") {
				const e = endWord() ?? endPipeline("&&");
				if (e !== null) return fail(e);
				i += 2;
				continue;
			}
			if (src[i + 1] === ">" && !inWord) {
				if (src[i + 2] === ">") return fail("an appending &>> redirection");
				pending = { fd: "&", op: ">" };
				i += 2;
				continue;
			}
			return fail("a background job");
		}
		if (c === ">" || c === "<") {
			// A descriptor is the digits written immediately before, unquoted.
			let fd: Redirect["fd"] = null;
			if (inWord) {
				if (wordQuoted || !/^\d+$/.test(word)) return fail("a redirection glued to a word");
				fd = Number(word);
				word = "";
				inWord = false;
			}
			if (pending !== null) return fail("a redirection with no target");
			if (c === "<") {
				if (src[i + 1] === "<" || src[i + 1] === ">" || src[i + 1] === "&") return fail("a heredoc or descriptor duplication on input");
				pending = { fd, op: "<" };
				i += 1;
				continue;
			}
			if (src[i + 1] === ">") {
				pending = { fd, op: ">>" };
				i += 2;
				continue;
			}
			if (src[i + 1] === "&") {
				pending = { fd, op: ">&" };
				i += 2;
				continue;
			}
			if (src[i + 1] === "|") return fail("a clobbering redirection");
			pending = { fd, op: ">" };
			i += 1;
			continue;
		}
		word += c;
		inWord = true;
		i += 1;
	}
	const e = endWord();
	if (e !== null) return fail(e);
	// A trailing `;` or newline leaves an empty last command, which is not an
	// error in sh — `ls;` is `ls`. A trailing `|`, `&&`, `||` is.
	if (argv.length === 0 && redirects.length === 0 && pending === null && stages.length === 0 && joinedBy === ";" && list.length > 0) {
		return { ok: true, list };
	}
	const f = endPipeline(null);
	if (f !== null) return fail(f);
	return { ok: true, list };
}

/**
 * A path argument, resolved the way read_file resolves one: against the
 * directory the command runs in, with symlinks in the deepest EXISTING
 * ancestor followed, and the not-yet-existing tail re-appended. `inside`
 * is whether that canonical path is the workspace root or under it. One
 * resolver for every consumer — the read-only allow asks "inside?", the
 * floor asks "what is this?" — so the two can never disagree about where
 * a path goes.
 */
export interface ResolvedPath {
	readonly canonical: string;
	readonly inside: boolean;
	/** Windows P2: why the word cannot be read as a path here — never
	 *  inside, and refused under a destructive verb */
	readonly opaque?: string;
}

/**
 * Windows P2 — how a path word reads. `posix` is every host but Windows,
 * unchanged. `msys` is Git Bash on win32 (P1 runs commands through it):
 * `C:\x`, `C:/x` and `/c/x` are `C:\x`, either separator separates, the
 * disk is case-insensitive, and every form that cannot be read exactly is
 * opaque (kiso-doc plan-windows-p2-design-2026-10-01.md).
 */
export interface PathDialect {
	readonly msys: boolean;
	readonly path: typeof posix;
}

const POSIX_DIALECT: PathDialect = { msys: false, path: posix };
const MSYS_DIALECT: PathDialect = { msys: true, path: win32 };

/** The dialect of the shell that runs commands here — read per call. */
export function hostDialect(): PathDialect {
	return process.platform === "win32" ? MSYS_DIALECT : POSIX_DIALECT;
}

const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/**
 * A Git Bash word as a Windows path, `/`-separated (`C:/x`, or relative),
 * each component as Win32 reads it (trailing dots and spaces dropped) —
 * or why it cannot be read: another machine, a device or namespace path,
 * a drive-relative or drive-rooted path, an MSYS mount inside Git's own
 * tree, a data stream, a device name. (An 8.3 short name needs no rule:
 * Windows resolves an existing one, and the real path expands it.)
 */
export function msysPath(word: string): { readonly native: string } | { readonly opaque: string } {
	const w = word.replace(/\\/g, "/");
	if (/^\/\/[?.]\//.test(w)) return { opaque: w[2] === "?" ? "a namespaced path" : "a device path" };
	if (w.startsWith("//")) return { opaque: "a UNC path (another machine)" };
	let rest: string;
	let drive = "";
	const lettered = /^([A-Za-z]):(.*)$/s.exec(w);
	const mounted = /^\/([A-Za-z])(\/.*)?$/s.exec(w);
	if (lettered !== null) {
		if (!lettered[2]!.startsWith("/")) return { opaque: "a drive-relative path" };
		drive = `${lettered[1]!.toUpperCase()}:`;
		rest = lettered[2]!;
	} else if (mounted !== null) {
		drive = `${mounted[1]!.toUpperCase()}:`;
		rest = mounted[2] ?? "/";
	} else if (w.startsWith("/")) {
		return { opaque: word.startsWith("\\") ? "a drive-rooted path" : "an MSYS mount (Git's own tree)" };
	} else rest = w;
	const parts: string[] = [];
	for (const part of rest.split("/")) {
		if (part === "" || part === "." || part === "..") {
			parts.push(part);
			continue;
		}
		if (part.includes(":")) return { opaque: "an alternate data stream" };
		const name = part.replace(/[. ]+$/, "");
		if (name === "") return { opaque: "a name Win32 rewrites" };
		if (DEVICE_NAME.test(name)) return { opaque: "a device name" };
		parts.push(name);
	}
	return { native: drive + parts.join("/") };
}

/** The well-known home subtrees that hold credentials or configuration
 *  that runs — one list for both chain members: the read-only allow
 *  never reads or lists under them, the floor never deletes them. */
export const HOME_SUBTREES: readonly string[] = [".ssh", ".config", ".kiso", ".gnupg", ".aws"];

/** The home subtrees for this host: on Windows, AppData too — credentials
 *  and configuration that runs live there (Windows P2). */
export function homeSubtrees(): readonly string[] {
	return hostDialect().msys ? [...HOME_SUBTREES, "AppData"] : HOME_SUBTREES;
}

/** A real path in the case the DISK holds it. The JS realpath keeps the
 *  case it was given, so on a case-insensitive disk `.ENV` stayed `.ENV`
 *  and walked past every name-based predicate (the lead's review, B2). */
export function realCase(p: string): string {
	try {
		return realpathSync.native(p);
	} catch {
		return p;
	}
}

export function resolveShellPath(workspaceRoot: string, cwd: string, word: string, dialect: PathDialect = hostDialect()): ResolvedPath {
	const { dirname, isAbsolute, join, relative } = dialect.path;
	if (dialect.msys) {
		const read = msysPath(word);
		if ("opaque" in read) return { canonical: word, inside: false, opaque: read.opaque };
		if (!isAbsolute(read.native) && "opaque" in msysPath(cwd)) return { canonical: word, inside: false, opaque: "relative to a directory that cannot be read" };
		word = read.native;
	}
	// B1 (the lead's review): `..` is taken on the REAL path, one component
	// at a time — never collapsed as text first. `link-out/..` is the parent
	// of where link-out POINTS, which is where the shell goes; collapsed as
	// text it was the workspace, and `cat link-out/../etc/hosts` printed.
	const top = isAbsolute(word) ? dialect.path.parse(word).root : "";
	let current = top === "" ? realCase(cwd) : dialect.msys ? dialect.path.normalize(top) : top;
	// past the last component that exists, the rest is text: nothing on
	// disk can redirect a path that does not exist
	const missing: string[] = [];
	for (const part of word.slice(top.length).split("/")) {
		if (part === "" || part === ".") continue;
		if (missing.length > 0) {
			if (part === "..") missing.pop();
			else missing.push(part);
			continue;
		}
		if (part === "..") {
			current = dirname(current);
			continue;
		}
		const next = join(current, part);
		if (existsSync(next)) current = realCase(next);
		else missing.push(part);
	}
	const canonical = missing.length > 0 ? join(current, ...missing) : current;
	// Windows: a `..` after a link — Win32 takes `..` as text, the POSIX
	// walk above takes it on the real path. Where the two land apart, the
	// word is not read at all.
	if (dialect.msys && word.split("/").includes("..")) {
		const lexical = resolveShellPath(workspaceRoot, cwd, dialect.path.resolve(realCase(cwd), word), dialect);
		if (lexical.canonical.toLowerCase() !== canonical.toLowerCase()) return { canonical: word, inside: false, opaque: "a `..` after a link (Windows and Git Bash may read it apart)" };
	}
	const rel = relative(realCase(workspaceRoot), canonical);
	return { canonical, inside: rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) };
}

/**
 * The FLOOR's reading of a command line (0.40.0 item 4) — the opposite
 * contract to `parseShell`. The read-only allow must refuse whatever it
 * cannot read exactly; the floor must never refuse to read, because a
 * line it gave up on is a line it let through. So this reader accepts
 * everything, approximately, and marks where each word stops being known:
 *
 *  - every simple command the line would run is returned in order,
 *    including the ones inside `$( )`, backticks and `( )` groups;
 *  - a word records the index where its first unknown character sits (a
 *    variable, a substitution, an unquoted glob), whether it began with
 *    an unquoted `~`, and whether it is ONLY a variable (`$DIR/`,
 *    `"${X}"/*`: nothing literal but slashes, dots and globs);
 *  - redirection targets and leading assignments are not arguments, and
 *    are dropped.
 */
export interface LooseWord {
	readonly text: string;
	/** Index of the first unknown character, or -1 when all is literal. */
	readonly unknownAt: number;
	/** Whether that first unknown is a glob (`*`), not a variable or a
	 *  substitution: a glob ranges over a directory's entries, a variable
	 *  can be anything at all. */
	readonly unknownIsGlob: boolean;
	readonly tilde: boolean;
	readonly variableOnly: boolean;
}

/** One command, and how it joins the one before it: after `cd x &&` it
 *  runs in x, after `cd x ||` in the old directory, after `;` in either. */
export interface LooseCommand {
	readonly kind: "cmd";
	readonly argv: readonly LooseWord[];
	readonly joinedBy: "&&" | "||" | ";" | "|";
	/** The words the reader drops — redirection targets and leading
	 *  assignments — kept only when the caller asks (`keepDropped`): the
	 *  floor judges what a command DOES, the protected-file check what a
	 *  line NAMES, and `< file` names a file. */
	readonly dropped?: readonly LooseWord[];
}

/** A subshell: a `( … )` group, or the command line inside `$( … )` or
 *  backticks (which runs BEFORE the command that holds it). A `cd` inside
 *  one does not move the shell around it. */
export interface LooseGroup {
	readonly kind: "group";
	readonly items: readonly LooseNode[];
	readonly joinedBy: "&&" | "||" | ";" | "|";
}

export type LooseNode = LooseCommand | LooseGroup;

/** B6 (the lead's review): how deep the reader follows nested subshells.
 *  A 9 KB `$(` nest overflowed the stack; the runtime turned the throw into
 *  an ask, bypass's allow won, and /bin/sh ran the line. Past this depth
 *  the word is taken as only a variable — which, as a target, is refused —
 *  and nothing deeper is read. */
export const LOOSE_MAX_DEPTH = 64;

/** Every command the line would run, in order, flattened — for a caller
 *  that asks the same question of each one. */
export function looseCommands(nodes: readonly LooseNode[]): LooseCommand[] {
	const out: LooseCommand[] = [];
	const walk = (ns: readonly LooseNode[]): void => {
		for (const n of ns) {
			if (n.kind === "cmd") out.push(n);
			else walk(n.items);
		}
	};
	walk(nodes);
	return out;
}

export function parseShellLoose(src: string): LooseNode[] {
	return parseLooseAt(src, 0, 0, false, { truncated: false, keepDropped: false }).items;
}

/** The same, saying whether the reader stopped short: a nest past
 *  LOOSE_MAX_DEPTH is not read, and a caller that must see every command
 *  (the floor) treats an unread line as one it could not read. */
export function parseShellLooseChecked(src: string, opts: { readonly keepDropped?: boolean } = {}): { readonly nodes: LooseNode[]; readonly truncated: boolean } {
	const flags = { truncated: false, keepDropped: opts.keepDropped === true };
	return { nodes: parseLooseAt(src, 0, 0, false, flags).items, truncated: flags.truncated };
}

/** One level of the reader, from `start`. With `closeParen`, it is the
 *  inside of `$(`: an unmatched `)` ends it and its index is returned — the
 *  recursion finds its own end, so a nest is read ONCE, in linear time,
 *  rather than scanned for its matching paren at every level. */
function parseLooseAt(src: string, start: number, depth: number, closeParen: boolean, flags: { truncated: boolean; readonly keepDropped: boolean }): { items: LooseNode[]; end: number } {
	// the open `( … )` groups at this level: [items so far, the joiner before the group]
	const stack: { items: LooseNode[]; joinedBy: LooseCommand["joinedBy"] }[] = [{ items: [], joinedBy: ";" }];
	let argv: LooseWord[] = [];
	let dropped: LooseWord[] = [];
	let joinedBy: LooseCommand["joinedBy"] = ";";
	let text = "";
	let lit = "";
	let inWord = false;
	let unknownAt = -1;
	let unknownIsGlob = false;
	let tilde = false;
	let startsWithExpansion = false;
	let tooDeep = false; // a nest past LOOSE_MAX_DEPTH: nothing in it is known
	let dropNext = false; // the next word is a redirection target
	let seenCommandWord = false;
	const top = (): LooseNode[] => stack[stack.length - 1]!.items;

	const markUnknown = (glob: boolean): void => {
		if (unknownAt < 0) {
			unknownAt = text.length;
			unknownIsGlob = glob;
		}
	};
	const endWord = (): void => {
		if (!inWord) return;
		const w: LooseWord = { text, unknownAt, unknownIsGlob, tilde, variableOnly: tooDeep || (startsWithExpansion && /^[/*.]*$/.test(lit)) };
		const assign = /^[A-Za-z_][A-Za-z0-9_]*=/.exec(text);
		if (dropNext) {
			dropNext = false;
			if (flags.keepDropped) dropped.push(w);
		} else if (!seenCommandWord && assign !== null && (unknownAt < 0 || unknownAt >= assign[0].length)) {
			// a leading assignment: environment for the command, not the
			// command — `X="$Y" rm …` included (B10: the value holding an
			// expansion made it the command, and hid the rm)
			if (flags.keepDropped) dropped.push(w);
		} else {
			argv.push(w);
			seenCommandWord = true;
		}
		text = "";
		lit = "";
		inWord = false;
		unknownAt = -1;
		unknownIsGlob = false;
		tilde = false;
		startsWithExpansion = false;
		tooDeep = false;
	};
	const endCommand = (next: LooseCommand["joinedBy"]): void => {
		endWord();
		// without keepDropped, exactly as before: a command with no words is
		// not a command. With it, `$(< file)` — a read with no command — is one
		if (flags.keepDropped) {
			if (argv.length > 0 || dropped.length > 0) top().push({ kind: "cmd", argv, joinedBy, dropped });
		} else if (argv.length > 0) top().push({ kind: "cmd", argv, joinedBy });
		argv = [];
		dropped = [];
		seenCommandWord = false;
		dropNext = false;
		// a separator after an empty command (`&& &&`) keeps the stronger one
		joinedBy = next;
	};
	const openGroup = (): void => {
		endCommand(joinedBy);
		// the `( )` groups count toward the same depth as `$( )`
		if (depth + stack.length > LOOSE_MAX_DEPTH) {
			flags.truncated = true;
			return;
		}
		stack.push({ items: [], joinedBy });
		joinedBy = ";";
	};
	const closeGroup = (): void => {
		endCommand(";");
		const g = stack.pop()!;
		top().push({ kind: "group", items: g.items, joinedBy: g.joinedBy });
	};
	/** An expansion at i (`$…` or a backtick): its raw text joins the word,
	 *  any command inside it is read as a subshell, and the index after it
	 *  is returned. */
	const expansion = (i: number): number => {
		// "only a variable" means nothing came before it — quotes add nothing
		if (text === "") startsWithExpansion = true;
		inWord = true;
		markUnknown(false);
		let j: number;
		if (src[i] === "`") {
			const close = src.indexOf("`", i + 1);
			j = close < 0 ? src.length : close + 1;
			// the subshell runs as part of the command that holds it, so it
			// takes that command's joiner (`cd x && echo \`…\`` runs it in x)
			if (depth < LOOSE_MAX_DEPTH) top().push({ kind: "group", items: parseLooseAt(src.slice(i + 1, close < 0 ? src.length : close), 0, depth + 1, false, flags).items, joinedBy });
			else {
				tooDeep = true;
				flags.truncated = true;
			}
		} else if (src[i + 1] === "(") {
			if (depth < LOOSE_MAX_DEPTH) {
				const inner = parseLooseAt(src, i + 2, depth + 1, true, flags);
				top().push({ kind: "group", items: inner.items, joinedBy });
				j = Math.min(inner.end + 1, src.length);
			} else {
				// too deep to read: consume to the matching paren, unread
				tooDeep = true;
				flags.truncated = true;
				let open = 0;
				for (j = i + 1; j < src.length; j += 1) {
					if (src[j] === "(") open += 1;
					else if (src[j] === ")" && --open === 0) break;
				}
				j = Math.min(j + 1, src.length);
			}
		} else if (src[i + 1] === "{") {
			const close = src.indexOf("}", i + 2);
			j = close < 0 ? src.length : close + 1;
		} else {
			j = i + 1;
			if (j < src.length && /[@*#?$!0-9-]/.test(src[j]!)) j += 1;
			else while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
		}
		// The raw text is kept for the messages only — nothing is judged on
		// what an expansion says, only on where it starts — so a long one is
		// kept short: a nest used to carry its whole remainder at every level.
		const raw = src.slice(i, j);
		text += raw.length > 256 ? `${raw.slice(0, 256)}…` : raw;
		return j;
	};

	let i = start;
	while (i < src.length) {
		const c = src[i]!;
		if (c === "'") {
			const close = src.indexOf("'", i + 1);
			const body = src.slice(i + 1, close < 0 ? src.length : close);
			text += body;
			lit += body;
			inWord = true;
			i = close < 0 ? src.length : close + 1;
			continue;
		}
		if (c === '"') {
			inWord = true;
			let j = i + 1;
			while (j < src.length && src[j] !== '"') {
				if (src[j] === "\\" && j + 1 < src.length) {
					text += src[j + 1];
					lit += src[j + 1];
					j += 2;
					continue;
				}
				if (src[j] === "$" || src[j] === "`") {
					j = expansion(j);
					continue;
				}
				text += src[j];
				lit += src[j];
				j += 1;
			}
			i = j + 1;
			continue;
		}
		if (c === "\\") {
			if (i + 1 < src.length && src[i + 1] !== "\n") {
				text += src[i + 1];
				lit += src[i + 1];
				inWord = true;
			}
			i += 2;
			continue;
		}
		if (c === "$" || c === "`") {
			i = expansion(i);
			continue;
		}
		if (c === "*" || c === "?" || c === "[") {
			markUnknown(true);
			text += c;
			lit += c;
			inWord = true;
			i += 1;
			continue;
		}
		if (c === "~" && !inWord) tilde = true;
		if (c === "#" && !inWord) {
			while (i < src.length && src[i] !== "\n") i += 1;
			continue;
		}
		if (c === " " || c === "\t") {
			endWord();
			i += 1;
			continue;
		}
		if (c === "(") {
			openGroup();
			i += 1;
			continue;
		}
		if (c === ")") {
			if (stack.length > 1) {
				closeGroup();
				i += 1;
				continue;
			}
			if (closeParen) {
				endCommand(";");
				return { items: top(), end: i };
			}
			endCommand(";"); // a stray `)` separates
			i += 1;
			continue;
		}
		if (c === ";" || c === "\n" || c === "&" || c === "|") {
			if (c === "&" && src[i + 1] === ">") {
				endWord();
				dropNext = true;
				i += src[i + 2] === ">" ? 3 : 2;
				continue;
			}
			const two = src.slice(i, i + 2);
			if (two === "&&" || two === "||") {
				endCommand(two);
				i += 2;
				continue;
			}
			endCommand(c === "|" ? "|" : ";");
			i += 1;
			continue;
		}
		if (c === ">" || c === "<") {
			if (inWord && /^\d+$/.test(text) && unknownAt < 0) {
				text = "";
				lit = "";
				inWord = false;
			} else endWord();
			let j = i + 1;
			while (j < src.length && (src[j] === ">" || src[j] === "<" || src[j] === "&" || src[j] === "|")) j += 1;
			// `>&1` and `2>&-` name a descriptor, not a file; either way the
			// word that follows is the operator's, never an argument.
			dropNext = true;
			i = j;
			continue;
		}
		text += c;
		lit += c;
		inWord = true;
		i += 1;
	}
	endCommand(";");
	while (stack.length > 1) closeGroup(); // an unclosed `(` closes at the end
	return { items: top(), end: src.length };
}
