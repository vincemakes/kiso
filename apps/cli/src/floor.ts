/**
 * 0.40.0 — the catastrophe floor (launch-weekend plan §4, minimum shape;
 * owner, 2026-09-17: "bypass stays bypass: `rm -rf /tmp/probe` runs. The
 * floor refuses only unrecoverable targets"; the lead's review and rulings
 * of 2026-09-18).
 *
 * A destructive command whose target cannot be recovered is REFUSED, in
 * every mode, bypass included, as a precondition — a chain member that
 * denies, and a deny is what nothing outranks. The destructive commands:
 * `rm`; `git clean -f`, `git reset --hard`, `git checkout -- <paths>` and
 * the same loss spelled `git checkout .` / `-f`, `git restore` touching
 * the worktree, `git switch -f` (R5); `find … -delete` with no selecting
 * primary before it (R6). The unrecoverable targets:
 *
 *  - `/`, the home directory, the workspace root or any directory above it;
 *  - the workspace's `.git` (R7);
 *  - `~/.ssh`, `~/.config`, `~/.kiso`, `~/.gnupg`, `~/.aws`, or inside one;
 *  - a system root and what is inside it — except the temp family and the
 *    software prefixes (/opt/homebrew, /usr/local, linuxbrew), where only
 *    the root itself is, and /Volumes /Users /home /mnt /media, where the
 *    root and its direct children are (R8). Inside the workspace or the
 *    home directory is never a system root's;
 *  - a wildcard over any of those (`~/*`, `/*`, `*` at the workspace root —
 *    a component of nothing but globs; `*.log` ranges over SOME entries);
 *  - a target that is only a variable (`$DIR/`, `"$X"/*`) — empty, it is
 *    the root of whatever comes after it. `$HOME` and `$PWD` are known.
 *
 * This is a reading of the command line, not a guarantee: the sandbox is
 * the guarantee, and it comes after the launch. So the reading errs toward
 * seeing a command — it looks inside `$( )`, backticks, `( )`, `sh -c` and
 * `eval`, through `sudo`/`env`/`timeout`/`command` and shell keywords, and
 * follows `cd` by its joiner — and a line that knocks the reader out is
 * denied. Documented, not refused: `xargs rm`, script files and heredocs,
 * `find -exec rm`, `mv`, `chmod -R`, `rmdir`, `unlink`, `truncate`,
 * `shred`, `>` truncation, `rsync --delete`, `npx rimraf`, `trash`,
 * `fish -c`, `ssh`, `docker`, `node -e` / `python -c` / `perl -e`, brace
 * expansion, `$'…'`, `~+`, popd past one level, nesting past 16.
 *
 * The same resolver as the read-only allow decides where a path goes.
 * Default on; `"floor": "off"` in the USER config turns it off, and a
 * project config cannot — a repository must not be able to lower it.
 */

import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, resolve, win32 } from "node:path";
import type { PolicyCall, PolicyVerdict } from "@vincemakes/kiso-core";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { homeSubtrees, hostDialect, looseCommands, msysPath, parseShellLooseChecked, resolveShellPath, type LooseNode, type LooseWord } from "./shell-words.js";

export type FloorVerdict = { readonly refused: false } | { readonly refused: true; readonly why: string };

/** R8 (the lead's ruling): a system root AND everything inside it. */
const SYSTEM_ROOTS = [
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/opt", "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/usr", "/var",
	"/Applications", "/Library", "/System", "/cores", "/private",
];
/** R8: roots whose DIRECT children are mounts or home directories — the
 *  root and each child are refused, deeper paths run (projects live
 *  there, WSL's included: /mnt/c/…). */
const MOUNT_ROOTS = ["/Volumes", "/Users", "/home", "/mnt", "/media"];
/** R8: the temp family — only the root itself; what is inside runs. */
const TEMP_ROOTS = ["/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"];
/** R8 (the lead's ruling, second pass): reinstallable software prefixes —
 *  only the prefix itself; what is inside runs (`brew` put it there and can
 *  again). */
const SOFTWARE_PREFIXES = ["/opt/homebrew", "/usr/local", "/home/linuxbrew/.linuxbrew"];

/** Windows P2: the same tables from the environment, never a hard-coded
 *  user name. System roots: SystemRoot and the program and data roots;
 *  the users root works as a mount root (it and each home in it refused);
 *  the temp family is TEMP/TMP. Every drive root is refused in
 *  `unrecoverable`. */
function windowsRoots(home: string): { sys: string[]; mounts: string[]; temps: string[]; prefixes: string[] } {
	const env = process.env;
	const set = (values: readonly (string | undefined)[]): string[] => values.filter((v): v is string => v !== undefined && v !== "");
	return {
		sys: set([env.SystemRoot, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData]),
		mounts: [win32.dirname(home)],
		temps: set([env.TEMP, env.TMP]),
		prefixes: [],
	};
}

interface Named {
	readonly name: string;
	readonly real: string;
}

interface Where {
	readonly root: string;
	readonly home: string;
	/** Canonical forms, computed ONCE: a line of many targets used to
	 *  realpath every system root for every one of them. */
	readonly rootReal: string;
	readonly homeReal: string;
	readonly gitReal: string;
	readonly sys: readonly Named[];
	readonly mounts: readonly Named[];
	readonly temps: readonly string[];
	readonly prefixes: readonly Named[];
	readonly subtrees: readonly Named[];
}

/** Memoized per (workspace, home): the roots do not move within a session,
 *  and resolving forty of them cost every shell call ~4 ms. */
const WHERE = new Map<string, Where>();

function where(root: string, home: string): Where {
	const dialect = hostDialect();
	const key = `${dialect.msys ? "msys" : "posix"}\0${root}\0${home}`;
	const hit = WHERE.get(key);
	if (hit !== undefined) return hit;
	const { join } = dialect.path;
	const real = (p: string): string => resolveShellPath(root, dialect.msys ? root : "/", p, dialect).canonical;
	const named = (names: readonly string[]): Named[] => names.map((name) => ({ name, real: real(name) }));
	const rootReal = real(root);
	const roots = dialect.msys ? windowsRoots(home) : { sys: SYSTEM_ROOTS, mounts: MOUNT_ROOTS, temps: [...TEMP_ROOTS, tmpdir()], prefixes: SOFTWARE_PREFIXES };
	const w: Where = {
		root,
		home,
		rootReal,
		homeReal: real(home),
		gitReal: join(rootReal, ".git"),
		sys: named(roots.sys),
		mounts: named(roots.mounts),
		temps: [...new Set(roots.temps.map(real))],
		prefixes: named(roots.prefixes),
		subtrees: homeSubtrees().map((name) => ({ name, real: real(join(home, name)) })),
	};
	WHERE.set(key, w);
	return w;
}

/** B6: the candidate directories a command may run in are UNIQUE and at
 *  most this many. `;`-joined cds doubled the set: 30 of them hung the
 *  event loop, 400 exhausted the heap. Past the bound the set collapses to
 *  the newest candidate, home and the workspace root — the three a
 *  catastrophe is judged against. */
const MAX_CWDS = 8;

function capCwds(w: Where, list: readonly string[]): string[] {
	const unique = [...new Set(list)];
	return unique.length <= MAX_CWDS ? unique : [...new Set([unique[0]!, w.home, w.root])];
}

const canon = (w: Where, cwd: string, p: string): string => resolveShellPath(w.root, cwd, p).canonical;
const within = (parent: string, p: string): boolean => {
	const { relative, isAbsolute } = hostDialect().path;
	const rel = relative(parent, p);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
/** The same path: case-insensitive on Windows (Windows P2). */
const same = (a: string, b: string): boolean => (hostDialect().msys ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Why `p` (canonical) is unrecoverable, or null. `over` is true for a
 *  wildcard over `p` rather than `p` itself — the same set, since
 *  emptying a directory is removing everything it held. */
function unrecoverable(w: Where, p: string, over: boolean): string | null {
	const what = (s: string): string => (over ? `a wildcard over ${s}` : s);
	const msys = hostDialect().msys;
	if (p === "/") return what("/");
	if (msys && win32.parse(p).root === p) return what(`a drive root (${p})`);
	if (same(p, w.homeReal)) return what("the home directory");
	if (same(p, w.rootReal)) return what("the workspace root");
	if (within(p, w.rootReal)) return what(`a directory above the workspace (${p})`);
	// R7: the workspace's history — without a remote, gone
	if (within(w.gitReal, p)) return what("the workspace's .git");
	// on Windows the temp root sits inside AppData: what is inside a temp
	// root that lies inside the subtree runs
	for (const sub of w.subtrees) if (within(sub.real, p) && !(msys && w.temps.some((t) => within(sub.real, t) && !same(p, t) && within(t, p)))) return what(`~/${sub.name}`);
	// Inside the workspace or the home directory is the project's and the
	// person's, never a system root's — or a workspace in /opt, or a root
	// user's home in /root, would have every rm refused.
	if ((w.rootReal !== "/" && within(w.rootReal, p)) || within(w.homeReal, p)) return null;
	for (const t of w.temps) {
		if (same(p, t)) return what(`a temp root (${t})`);
		if (within(t, p)) return null;
	}
	for (const x of w.prefixes) {
		if (same(p, x.real)) return what(`a software prefix (${x.name})`);
		if (within(x.real, p)) return null;
	}
	for (const m of w.mounts) {
		if (same(p, m.real)) return what(`a system root (${m.name})`);
		if (same(hostDialect().path.dirname(p), m.real)) return what(`a mount or home root (${p})`);
		// deeper runs — by RESOLVED path: macOS's /home is
		// /System/Volumes/Data/home, which the /System rule would refuse
		if (within(m.real, p)) return null;
	}
	for (const s of w.sys) {
		if (same(p, s.real)) return what(`a system root (${s.name})`);
		if (within(s.real, p)) return what(`a path inside a system root (${s.name})`);
	}
	return null;
}

/** Where the first unknown character sits in `text`, and whether it is a
 *  glob — for a word whose text a known variable was just substituted in. */
function reUnknown(text: string, from: number): { at: number; glob: boolean } {
	for (let i = from; i < text.length; i += 1) {
		const c = text[i]!;
		if (c === "*" || c === "?" || c === "[") return { at: i, glob: true };
		if (c === "$" || c === "`") return { at: i, glob: false };
	}
	return { at: -1, glob: false };
}

/** One target word, from each directory the command might run in. */
function targetWhy(w: Where, cwds: readonly string[], word: LooseWord): string | null {
	for (const cwd of cwds) {
		// Windows P2: either separator separates (the same length, so the
		// unknown positions hold)
		let text = hostDialect().msys ? word.text.replace(/\\/g, "/") : word.text;
		let at = word.unknownAt;
		let glob = word.unknownIsGlob;
		let variableOnly = word.variableOnly;
		// B8: $HOME and $PWD are KNOWN — `rm -rf $HOME/.ssh` is ~/.ssh
		const known = at === 0 ? /^(\$HOME|\$\{HOME\}|\$PWD|\$\{PWD\})(?=\/|$)/.exec(text) : null;
		if (known !== null) {
			const value = known[1]!.includes("HOME") ? w.home : cwd;
			text = value + text.slice(known[0].length);
			({ at, glob } = reUnknown(text, value.length));
			variableOnly = false;
		} else if (word.tilde && (text === "~" || text.startsWith("~/"))) {
			text = w.home + text.slice(1);
			if (at >= 0) at += w.home.length - 1;
		}
		if (variableOnly) return `a target that is only a variable (${word.text})`;
		if (at < 0) {
			const target = resolveShellPath(w.root, cwd, text);
			if (target.opaque !== undefined) return `${word.text}, ${target.opaque}`;
			const why = unrecoverable(w, target.canonical, false);
			if (why !== null) return why;
			continue;
		}
		// A variable FIRST, with something literal after it (`$X/build`),
		// can be anything at all; only a variable-only target is refused.
		if (at === 0 && !glob) continue;
		const prefix = text.slice(0, at);
		const lastSlash = prefix.lastIndexOf("/");
		const over = resolveShellPath(w.root, cwd, lastSlash < 0 ? "." : prefix.slice(0, lastSlash + 1) || "/");
		if (over.opaque !== undefined) return `a wildcard in ${word.text}, ${over.opaque}`;
		const dir = over.canonical;
		const head = prefix.slice(lastSlash + 1); // the literal start of the unknown component
		const nextSlash = text.indexOf("/", at);
		const component = text.slice(lastSlash + 1, nextSlash < 0 ? text.length : nextSlash);
		const after = nextSlash < 0 ? "" : text.slice(nextSlash);
		// B8: a wildcard INSIDE a protected subtree (`~/.ssh/id_*`), or at
		// home reaching one by its name (`~/.ssh*`, `~/.c*`)
		for (const sub of w.subtrees) {
			if (within(sub.real, dir)) return `a wildcard inside ~/${sub.name}`;
			if (glob && same(dir, w.homeReal) && head !== "" && sub.name.toLowerCase().startsWith(head.toLowerCase())) return `a wildcard that reaches ~/${sub.name}`;
		}
		// B9: over the directory ONLY when the unknown component is nothing
		// but glob characters and dots (`*`, `.*`, `**`, `?`), or nothing but
		// a variable — and what follows is only slashes, dots and globs.
		// `*.log`, `a*`, `**/node_modules` range over SOME entries and run.
		const overComponent = glob ? /^[*?.[\]!]+$/.test(component) : head === "" && /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\(.*\)|`.*`)$/.test(component);
		// ...and that exemption holds only where ranging over SOME entries is
		// ordinary work: inside the workspace, inside home (the subtrees were
		// refused above), in the temp family. `/*.log`, `/**/build` are not.
		const ordinary = within(w.rootReal, dir) || within(w.homeReal, dir) || w.temps.some((t) => within(t, dir));
		if (ordinary && (!overComponent || !/^[/.*?[\]!]*$/.test(after))) continue;
		const why = unrecoverable(w, dir, true);
		if (why !== null) return why;
	}
	return null;
}

const WRAPPER_ARG: Readonly<Record<string, readonly string[]>> = {
	sudo: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U"],
	doas: ["-u", "-C"],
	nice: ["-n"],
	exec: ["-a"],
	env: ["-u", "-C", "-S"],
	timeout: ["-s", "-k", "--signal", "--kill-after"],
	command: [],
	builtin: [],
	nohup: [],
	time: [],
	busybox: [],
};
/** B10: shell keywords that come before a command and take nothing */
const KEYWORD_BEFORE = new Set(["if", "then", "elif", "else", "while", "until", "do", "{", "!"]);
/** B10: keywords that end a construct — a command on their own */
const KEYWORD_ALONE = new Set(["fi", "done", "}", "esac", "in"]);

/** Past keywords, `sudo -u x`, `env A=1`, `timeout 5`, `command`, … to the
 *  command that runs. Matched by basename: `/usr/bin/env rm` is env. */
export function unwrap(argv: readonly LooseWord[]): readonly LooseWord[] {
	let a = argv;
	for (;;) {
		// a leading word that is only a variable may be EMPTY (`$SUDO rm …`,
		// `eval "$X" rm …`): the command may be what follows it
		while (a.length > 1 && a[0]!.variableOnly) a = a.slice(1);
		const name = basename(a[0]?.text ?? "");
		if (a.length === 0 || KEYWORD_ALONE.has(name)) return [];
		if (KEYWORD_BEFORE.has(name)) {
			a = a.slice(1);
			continue;
		}
		if (!Object.hasOwn(WRAPPER_ARG, name)) return a;
		let i = 1;
		while (i < a.length && (a[i]!.text.startsWith("-") || (name === "env" && a[i]!.text.includes("=")))) {
			i += WRAPPER_ARG[name]!.includes(a[i]!.text) ? 2 : 1;
		}
		if (name === "timeout") i += 1; // the duration
		a = a.slice(i);
	}
}

const operands = (args: readonly LooseWord[]): LooseWord[] => {
	const out: LooseWord[] = [];
	let rest = false;
	for (const a of args) {
		if (!rest && a.text === "--") rest = true;
		else if (rest || !a.text.startsWith("-")) out.push(a);
	}
	return out;
};

const literal = (text: string): LooseWord => ({ text, unknownAt: -1, unknownIsGlob: false, tilde: false, variableOnly: false });

/** `sh -c '…'`, `bash -lc '…'`, `eval …`: the command lines inside.
 *  eval CONCATENATES its words with spaces and parses the result again —
 *  that is its meaning, and `eval 'rm -rf ~'` is read that way. It is also
 *  read once more with each word re-quoted, so `eval sh -c 'rm -rf /'`
 *  keeps its script whole (B10, the lead's reading): either refusing is a
 *  refusal. In the re-quoted reading `~` is already expanded and a word
 *  holding an unknown stays raw — its value is unknown to eval too. */
export function innerLines(argv: readonly LooseWord[], home: string): { readonly lines: readonly string[]; readonly subshell: boolean } | null {
	const name = basename(argv[0]?.text ?? "");
	const quote = (t: string): string => `'${t.replaceAll("'", `'\\''`)}'`;
	if (name === "eval") {
		const words = argv.slice(1);
		const requoted = words.map((a) => (a.tilde && (a.text === "~" || a.text.startsWith("~/")) ? quote(home + a.text.slice(1)) : a.unknownAt >= 0 ? a.text : quote(a.text)));
		return { lines: [words.map((a) => a.text).join(" "), requoted.join(" ")], subshell: false };
	}
	if (!/^(ba|z|da|k)?sh$/.test(name)) return null;
	const at = argv.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a.text));
	const line = at < 0 ? undefined : argv[at + 1]?.text;
	return line === undefined ? null : { lines: [line], subshell: true };
}

/** How deep command lines inside command lines are followed — `sh -c`,
 *  `eval` — and how many are read in all: eval's two readings would
 *  otherwise double at every level. */
const MAX_INNER_DEPTH = 16;
const MAX_INNER_LINES = 256;

/** A target: a word, or the root of the repository a git command runs in. */
type Target = LooseWord | "repo";

const SELECTING = new Set([
	"-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-newer", "-mtime", "-mmin", "-atime",
	"-amin", "-ctime", "-cmin", "-size", "-empty", "-user", "-group", "-perm", "-samefile", "-links",
]);

/** R5: a checkout/restore operand is a path only when path-shaped — a
 *  branch name is never refused. */
const pathShaped = (t: string): boolean =>
	t === "." || t === "./" || t.startsWith("/") || t.startsWith("~") || t.includes("/") || t.startsWith(":") || (hostDialect().msys && (t.includes("\\") || /^[A-Za-z]:/.test(t)));
/** B7: pathspec magic from the top of the repository */
const topMagic = (t: string): boolean => t.startsWith(":/") || t.startsWith(":(top");

interface Destructive {
	readonly targets: readonly Target[];
	/** `git -C A -C B`: where the command runs, each relative to the last */
	readonly cds?: readonly LooseWord[];
	/** how the refusal names the command */
	readonly label?: string;
	/** R6: a find that selects — only a home subtree refuses it */
	readonly subtreesOnly?: boolean;
}

/** The destructive command's targets, or null when it is not destructive. */
function destructiveTargets(argv: readonly LooseWord[]): Destructive | null {
	const name = basename(argv[0]?.text ?? "");
	const args = argv.slice(1);
	if (name === "rm") return { targets: operands(args) };
	if (name === "find") {
		if (!args.some((a) => a.text === "-delete")) return null;
		const paths: LooseWord[] = [];
		let i = 0;
		// B9: find's own options come first — -H -L -P -E -d -s -x -O<n> --,
		// and -f <path> names a path
		for (; i < args.length; i += 1) {
			const t = args[i]!.text;
			if (/^-[HLPEdsx]+$/.test(t) || /^-O\d*$/.test(t)) continue;
			if (t === "-f" && i + 1 < args.length) {
				paths.push(args[i + 1]!);
				i += 1;
				continue;
			}
			if (t === "--") i += 1;
			break;
		}
		for (; i < args.length; i += 1) {
			const t = args[i]!.text;
			if (t.startsWith("-") || t === "!" || t === "(") break;
			paths.push(args[i]!);
		}
		// R6 (the lead's ruling): with a selecting primary it ranges over SOME
		// entries and runs; with none, over everything under its paths
		// ...and only BEFORE -delete: `find . -delete -name x` deletes all.
		// The home subtrees come first even so (`find ~/.ssh -name x -delete`)
		const del = args.findIndex((a) => a.text === "-delete");
		if (args.slice(i, del).some((a) => SELECTING.has(a.text))) return { targets: paths.length > 0 ? paths : [literal(".")], subtreesOnly: true };
		return { targets: paths.length > 0 ? paths : [literal(".")], label: "find with no selecting primary" };
	}
	if (name !== "git") return null;
	let i = 0;
	// B7: several -C compose, each relative to the one before
	const cds: LooseWord[] = [];
	// B7: --work-tree X IS the tree a whole-tree command works on; --git-dir
	// X is a target in itself (space and = forms both)
	let workTree: LooseWord | undefined;
	const gitDirs: LooseWord[] = [];
	while (i < args.length && args[i]!.text.startsWith("-")) {
		const t = args[i]!.text;
		const eq = /^--(work-tree|git-dir)=(.*)$/.exec(t);
		if (eq !== null) {
			const value = { ...args[i]!, text: eq[2]!, unknownAt: -1, tilde: eq[2]!.startsWith("~") };
			if (eq[1] === "work-tree") workTree = value;
			else gitDirs.push(value);
		}
		if ((t === "-C" || t === "--work-tree" || t === "--git-dir") && i + 1 < args.length) {
			if (t === "-C") cds.push(args[i + 1]!);
			else if (t === "--work-tree") workTree = args[i + 1];
			else gitDirs.push(args[i + 1]!);
			i += 2;
		} else if (t === "-c" || t === "--namespace" || t === "--exec-path") i += 2;
		else i += 1;
	}
	const sub = args[i]?.text;
	const rest = args.slice(i + 1);
	const flags = new Set(rest.filter((a) => a.text.startsWith("-")).map((a) => a.text));
	const as = (targets: Target[]): Destructive => ({
		targets: [...targets.map((t) => (t === "repo" && workTree !== undefined ? workTree : t)), ...gitDirs],
		...(cds.length > 0 ? { cds } : {}),
	});
	// a pathspec's glob is GIT's to expand, quoted from the shell or not:
	// `git checkout -- '*'` is every file under the directory
	const asGlob = (wd: LooseWord): LooseWord => {
		const g = wd.text.search(/[*?[]/);
		return wd.unknownAt < 0 && g >= 0 ? { ...wd, unknownAt: g, unknownIsGlob: true } : wd;
	};
	const asPaths = (words: readonly LooseWord[]): Target[] => words.map((wd) => (topMagic(wd.text) ? "repo" : asGlob(wd)));
	if (sub === "reset") return flags.has("--hard") ? as(["repo"]) : null;
	if (sub === "clean") {
		if (!rest.some((a) => a.text === "--force" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a.text))) return null;
		// a dry run deletes nothing, wherever its -n sits
		if (rest.some((a) => a.text === "--dry-run" || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a.text))) return null;
		const paths = operands(rest.filter((_, k) => !(k > 0 && (rest[k - 1]!.text === "-e" || rest[k - 1]!.text === "--exclude"))));
		return as(paths.length > 0 ? asPaths(paths) : [literal(".")]);
	}
	if (sub === "checkout") {
		// R5: `checkout -- <paths>`, a path-shaped operand, or -f with none
		const dd = rest.findIndex((a) => a.text === "--");
		const paths = dd >= 0 ? rest.slice(dd + 1) : operands(rest).filter((a) => pathShaped(a.text));
		if (paths.length > 0) return as(asPaths(paths));
		return flags.has("-f") || flags.has("--force") ? as(["repo"]) : null;
	}
	if (sub === "restore") {
		// R5: touching the worktree — no --staged, or -W / --worktree
		const staged = [...flags].some((f) => f === "--staged" || /^-[a-zA-Z]*S[a-zA-Z]*$/.test(f));
		const worktree = [...flags].some((f) => f === "--worktree" || /^-[a-zA-Z]*W[a-zA-Z]*$/.test(f));
		if (staged && !worktree) return null;
		const paths = operands(rest.filter((_, k) => !(k > 0 && (rest[k - 1]!.text === "-s" || rest[k - 1]!.text === "--source"))));
		return as(asPaths(paths));
	}
	if (sub === "switch") return flags.has("-f") || flags.has("--force") || flags.has("--discard-changes") ? as(["repo"]) : null;
	return null;
}

/** As git's own discovery judges it: a `.git` FILE (a worktree's link),
 *  or a `.git` directory with a HEAD. An empty `.git` is not a repository,
 *  and git walks on past it — so does the floor. */
function isGitDir(p: string): boolean {
	try {
		const st = statSync(p);
		return st.isFile() || (st.isDirectory() && existsSync(hostDialect().path.join(p, "HEAD")));
	} catch {
		return false;
	}
}

/** B7: the root of the repository a command in `cwd` works on — up to the
 *  nearest `.git` (a directory, or a worktree's file). With none found:
 *  inside the workspace, the workspace root; outside it, the directory
 *  itself — git would refuse to run there, and the floor does not bet on it. */
function repoRoot(w: Where, cwd: string): string {
	const { dirname, join } = hostDialect().path;
	const start = canon(w, cwd, ".");
	for (let d = start; ; d = dirname(d)) {
		if (isGitDir(join(d, ".git"))) return d;
		if (dirname(d) === d) break;
	}
	return within(w.rootReal, start) ? w.rootReal : start;
}

/** Windows P2: where a cd to an unreadable path lands — every relative
 *  path from it is unreadable too. */
const UNREADABLE_DIR = "//?/unreadable";

/** Where `cd text` from `c` lands, as the shell spells it (lexically). */
function cdTo(c: string, text: string): string {
	if (!hostDialect().msys) return resolve(c, text);
	const read = msysPath(text);
	return "opaque" in read || c === UNREADABLE_DIR ? UNREADABLE_DIR : win32.resolve(c, read.native);
}

interface CdState {
	cwds: string[];
	/** after `cd x`, until a joiner other than `&&` settles it */
	lastCd: { readonly to: string[]; readonly from: string[] } | null;
	/** one level of `cd -` / popd */
	prev: string[] | null;
}

/** A child shell starts where this node runs — the node's joiner has
 *  already been applied — and nothing it does comes back. */
const child = (s: CdState): CdState => ({ cwds: [...s.cwds], lastCd: null, prev: s.prev });

/**
 * Would the floor refuse this command line? `workspaceRoot` is where the
 * shell runs it.
 */
export function floorCheck(commandLine: string, workspaceRoot: string, home: string = homedir()): FloorVerdict {
	const w = where(workspaceRoot, home);
	const seen = new Set<string>();
	const tilde = (word: LooseWord): string => (word.tilde && (word.text === "~" || word.text.startsWith("~/")) ? home + word.text.slice(1) : word.text);

	const walk = (nodes: readonly LooseNode[], state: CdState, depth: number): FloorVerdict => {
		for (const node of nodes) {
			// Where this node runs: after `cd x`, `&&` means only if the cd
			// worked (x), `||` only if it failed (where it was), else either.
			if (state.lastCd !== null) {
				const { to, from } = state.lastCd;
				state.cwds = capCwds(w, node.joinedBy === "&&" ? to : node.joinedBy === "||" ? from : [...to, ...from]);
				if (node.joinedBy !== "&&") state.lastCd = null;
			}
			if (node.kind === "group") {
				// B10: a subshell — `( … )`, `$( … )`, backticks — its cd does
				// not move the shell around it
				const v = walk(node.items, child(state), depth);
				if (v.refused) return v;
				continue;
			}
			const argv = unwrap(node.argv);
			if (argv.length === 0) continue;
			const name = basename(argv[0]!.text);
			const inner = innerLines(argv, home);
			if (inner !== null) {
				if (depth < MAX_INNER_DEPTH) {
					for (const line of inner.lines) {
						if (seen.has(line) || seen.size >= MAX_INNER_LINES) continue;
						seen.add(line);
						// `sh -c` is a child shell: its cd does not move this one.
						// eval runs HERE, and its cd does — from this node's
						// directory, with the outer chain's pending cd kept if the
						// line itself does not cd
						const read = parseShellLooseChecked(line);
						if (read.truncated) return { refused: true, why: NESTED_TOO_DEEP };
						if (inner.subshell) {
							const v = walk(read.nodes, child(state), depth + 1);
							if (v.refused) return v;
						} else {
							const pending = state.lastCd;
							state.lastCd = null;
							const v = walk(read.nodes, state, depth + 1);
							if (v.refused) return v;
							if (state.lastCd === null) state.lastCd = pending;
						}
					}
				}
				continue;
			}
			if (name === "cd" || name === "pushd" || name === "popd") {
				// B10: skip cd's own options; `cd -` and popd go back one
				const args = argv.slice(1).filter((a) => !["--", "-P", "-L", "-e", "-@"].includes(a.text));
				const to = args[0];
				const from = state.lastCd?.from ?? state.cwds;
				let dest: string[];
				if (name === "popd" || to?.text === "-") dest = state.prev ?? state.cwds;
				// `cd` with nothing, or with anything unknown, may land at home
				else if (to === undefined || to.unknownAt >= 0 || to.variableOnly) dest = capCwds(w, [w.home, ...state.cwds]);
				else dest = capCwds(w, state.cwds.map((c) => cdTo(c, tilde(to))));
				state.prev = state.cwds;
				state.lastCd = { to: dest, from };
				continue;
			}
			const d = destructiveTargets(argv);
			if (d === null) continue;
			let here = state.cwds;
			for (const cd of d.cds ?? []) here = cd.unknownAt >= 0 ? capCwds(w, [...here, w.home]) : here.map((c) => cdTo(c, tilde(cd)));
			for (const t of d.targets) {
				let why: string | null = null;
				if (t === "repo") {
					for (const c of here) if ((why = c === UNREADABLE_DIR ? "a repository in a directory that cannot be read" : unrecoverable(w, repoRoot(w, c), false)) !== null) break;
				} else why = targetWhy(w, here, t);
				if (why !== null && d.subtreesOnly === true && !why.includes("~/.")) why = null;
				if (why !== null) {
					const command = argv.map((a) => a.text).join(" ");
					return { refused: true, why: d.label !== undefined ? `${command} — ${d.label} over ${why}` : `${command} — its target is ${why}` };
				}
			}
		}
		return { refused: false };
	};
	const top = parseShellLooseChecked(commandLine);
	if (top.truncated) return { refused: true, why: NESTED_TOO_DEEP };
	return walk(top.nodes, { cwds: [workspaceRoot], lastCd: null, prev: null }, 0);
}

/** B6, second pass: a line the reader stopped short on is a line it could
 *  not read — past the nesting it follows, bash still runs every level. */
const NESTED_TOO_DEEP = "the line is nested deeper than the floor reads";

/** Is there a destructive command anywhere in the line, whatever its
 *  target? A saved allow is never inherited by one (plan §4). */
export function isDestructive(commandLine: string): boolean {
	const seen = new Set<string>();
	const visit = (line: string, depth: number): boolean => {
		const read = parseShellLooseChecked(line);
		return read.truncated || looseCommands(read.nodes).some(({ argv: raw }) => {
			const argv = unwrap(raw);
			const inner = innerLines(argv, homedir());
			if (inner !== null) {
				return (
					depth < MAX_INNER_DEPTH &&
					inner.lines.some((l) => {
						if (seen.has(l) || seen.size >= MAX_INNER_LINES) return false;
						seen.add(l);
						return visit(l, depth + 1);
					})
				);
			}
			return destructiveTargets(argv) !== null;
		});
	};
	return visit(commandLine, 0);
}

const ABSTAIN: PolicyVerdict = { action: "abstain" };

/** The chain member, at the chain's head: DENY or ABSTAIN. */
export function floorExtension(on: () => boolean, workspaceRoot: () => string, check: typeof floorCheck = floorCheck): KisoExtension {
	return {
		name: "floor",
		approvals: [
			{
				decide: (call) => {
					if (call.name !== "shell" || !on()) return ABSTAIN;
					const command = call.input.command;
					if (typeof command !== "string") return ABSTAIN;
					// B6: a read that THROWS is not "a line it cannot follow" — it
					// is a line that knocked the reader out, and letting the
					// runtime degrade the throw to an ask handed it to bypass's
					// allow. The floor denies what it could not read.
					let v: FloorVerdict;
					try {
						v = check(command, workspaceRoot());
					} catch (err) {
						return { action: "deny", reason: `the floor could not read this line (${err instanceof Error ? err.name : "error"}) — kiso does not run it.` };
					}
					return v.refused ? { action: "deny", reason: `the floor refused this: ${v.why}. kiso never runs it, in any mode.` } : ABSTAIN;
				},
			},
		],
	};
}

/** Plan §4: "destructive commands never inherit a saved allow in the
 *  asking modes" — the predicate the saved-allow wrap
 *  (protected-writes.ts) is given, keyed on destructiveness, not on the
 *  target: a saved allow never runs even `rm -rf build` unasked. */
export function isDestructiveCall(call: PolicyCall): boolean {
	if (call.name !== "shell" || typeof call.input.command !== "string") return false;
	// B6: unreadable is treated as destructive — the saved allow abstains
	try {
		return isDestructive(call.input.command);
	} catch {
		return true;
	}
}
