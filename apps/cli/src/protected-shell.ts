/**
 * kiso never serves its own credential store to a model — the SHELL half.
 * The file tools refuse in tools-node, whose protected.ts holds the rule
 * (what is protected, and how a path is matched to it).
 *
 * A chain member at the head, beside the floor, in EVERY mode including
 * bypass: any word of any command in the line that resolves to a protected
 * file DENIES. The `!` gesture runs the same check before it runs a line,
 * because `!cmd` sends that line's output to the model.
 *
 * THIS IS A READING, NOT A GUARANTEE. It reads the line as the floor does:
 * the loose reader, `cd` followed, subshells and `sh -c`/`eval` inner lines
 * read, `~`, `$HOME` and `$KISO_HOME` expanded, `--opt=path` split, and the
 * words the floor drops kept — a redirection's target, an assignment's
 * value. A word is resolved by the KERNEL, as the command would open it:
 * one `stat` of the directory it runs in joined to the word, compared by
 * inode — so a symlink, a `..` through one, a case variant and a hard link
 * under another name all reach the same file. A protected path that does
 * not exist yet has no inode: until the file is created it is matched by
 * its spelling, resolved against the directory the word runs in (so is a
 * name-suffixed sibling, the writer's temp file). A glob is matched against
 * the protected files themselves, and only when its literal directory
 * holds one. A word it cannot resolve (a variable, a substitution, another
 * user's `~name`), or a relative word read after a `cd` it could not
 * follow, denies when it still contains a protected file's name. So does a
 * command that names a directory holding a protected file AND that file's
 * name, in two words (`find ~/.kiso -name auth.json`). A line it cannot
 * read to the end — nested too deep, or past its budget of disk reads —
 * denies.
 *
 * Its blind spots are stated, not hidden: a path assembled at run time
 * (`base64 -d`, string slicing), a copy under another name made in an
 * earlier call, a script that reads the file, a recursive walk over a
 * directory that holds it without naming it (`grep -r x ~`). The
 * guarantee is the sandbox, which stays post-launch.
 */

import { readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { basename } from "node:path";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { protectedIdentity, PROTECTED_REFUSAL, type ProtectedIdentity } from "@vincemakes/kiso-tools-node";
import { innerLines, unwrap } from "./floor.js";
import { hostDialect, msysPath, parseShellLooseChecked, type LooseNode, type LooseWord, type PathDialect } from "./shell-words.js";

/** A hit names the word that reached a protected file — or, `unread`,
 *  says why the line could not be read to the end. */
export type ProtectedVerdict = { readonly hit: false } | { readonly hit: true; readonly why: string; readonly unread: boolean };

export interface ProtectedShellEnv {
	/** what `~` and `$HOME` stand for */
	readonly home: string;
	/** what `$KISO_HOME` stands for */
	readonly kisoHome: string;
}

const ABSTAIN = { action: "abstain" } as const;
/** How deep `sh -c`/`eval` lines are followed, and how many are read. */
const MAX_INNER_DEPTH = 16;
const MAX_INNER_LINES = 256;
/** Past this many candidate directories the walk stops tracking them one
 *  by one and falls back to the name check (`cd a; cd b; …` doubles). */
const MAX_CWDS = 32;
/** A directory spelled longer than any system opens is not a directory
 *  a command can run in. */
const MAX_PATH = 4096;
/** Path readings per line — one word from one candidate directory: at
 *  most one `stat` each. A line a person or a model writes needs a few
 *  hundred; 8,000 bounds the hostile ones to ~15 ms on a laptop, and under
 *  100 ms on a loaded 2-core CI runner, where 20,000 measured 139 ms. A
 *  line that needs more is not read to the end, and a line not read to
 *  the end denies. */
const MAX_READINGS = 8_000;
/** Directory changes per line the check follows. Each one respells every
 *  candidate directory, so an unbounded run of `cd a;` is quadratic; a
 *  line a person or a model writes changes directory a handful of times. */
const MAX_CDS = 64;

export const NESTED_TOO_DEEP = "the line is nested deeper than the check reads";
export const TOO_LONG = "the line names more paths than the check reads";
export const TOO_MANY_CDS = "the line changes directory more times than the check follows";

class Unread extends Error {}

/** Where the next command runs: the directories it may run in (spelled,
 *  not resolved — the kernel resolves them at `stat`), and whether that
 *  list is a guess. */
interface CdState {
	cwds: string[];
	lossy: boolean;
	/** the directories a `cd` just moved to, pending the next joiner */
	pending: string[] | null;
}

const child = (s: CdState): CdState => ({ cwds: s.cwds, lossy: s.lossy, pending: s.pending });

function cap(s: CdState, list: readonly string[]): string[] {
	const fit = list.filter((d) => d.length <= MAX_PATH);
	if (fit.length < list.length) s.lossy = true;
	const unique = [...new Set(fit)];
	if (unique.length <= MAX_CWDS) return unique;
	s.lossy = true;
	return unique.slice(0, MAX_CWDS);
}

const inode = (st: Stats): string => `${st.dev}:${st.ino}`;

/** A shell glob as a whole-path test. `*` and `?` are taken to match a
 *  leading dot too — looser than the shell's default, on purpose: a
 *  line can turn `dotglob` on. */
function globRegex(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i += 1) {
		const c = glob[i]!;
		if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "[") {
			const close = glob.indexOf("]", i + 2);
			if (close < 0) re += "\\[";
			else {
				const body = glob.slice(i + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\");
				re += `[${body}]`;
				i = close;
			}
		} else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
	}
	// case-folded: on a disk that folds case, `.KISO/*` is the same directory
	return new RegExp(`^${re}$`, "i");
}

/** The disk facts one check compares against, read once per line: the
 *  inodes of the protected files and their existing name-suffixed
 *  siblings, their disk paths (for a glob), and the inodes of every
 *  directory that holds one — its own and each above it. */
interface Probe {
	readonly files: ReadonlySet<string>;
	readonly dirs: ReadonlySet<string>;
	readonly targets: readonly string[];
}

function probeFor(id: ProtectedIdentity, { msys, path }: PathDialect): Probe {
	const { basename, dirname, join } = path;
	const files = new Set<string>();
	const dirs = new Set<string>();
	const targets: string[] = [];
	for (const pf of id.paths) {
		const dir = dirname(pf);
		const base = basename(pf);
		targets.push(pf);
		try {
			for (const name of readdirSync(dir)) if (name.startsWith(`${base}.`)) targets.push(msys ? join(dir, name) : `${dir}/${name}`);
		} catch {
			// no directory yet — nothing in it to serve
		}
		for (let d = dir; ; d = dirname(d)) {
			const st = statSync(d, { throwIfNoEntry: false });
			if (st?.isDirectory() === true) dirs.add(inode(st));
			if (dirname(d) === d) break;
		}
	}
	for (const t of targets) {
		const st = statSync(t, { throwIfNoEntry: false });
		if (st?.isFile() === true) files.add(inode(st));
	}
	return { files, dirs, targets };
}

/** The pure check: does any word of the line name a protected file? */
export function protectedShellCheck(line: string, workspaceRoot: string, id: ProtectedIdentity, env: ProtectedShellEnv): ProtectedVerdict {
	if (id.paths.length === 0) return { hit: false };
	const dialect = hostDialect();
	const P = dialect.path;
	const probe = probeFor(id, dialect);
	const names = id.paths.map((p) => P.basename(p).toLowerCase());
	const paths = id.paths.map((p) => p.toLowerCase());
	const namesProtected = (t: string): boolean => {
		const low = t.toLowerCase();
		return names.some((n) => low.includes(n));
	};

	let readings = 0;
	const charge = (): void => {
		if (++readings > MAX_READINGS) throw new Unread(TOO_LONG);
	};
	const seenStat = new Map<string, Stats | undefined>();
	/** The kernel's answer for a path, as a command would open it: `..`
	 *  after a symlink is the symlink target's parent, because the string
	 *  is never normalized before the kernel reads it. */
	const statAt = (p: string): Stats | undefined => {
		if (seenStat.has(p)) return seenStat.get(p);
		let st: Stats | undefined;
		try {
			st = statSync(p, { throwIfNoEntry: false });
		} catch {
			st = undefined; // too long, not a directory, no permission: nothing it opens
		}
		seenStat.set(p, st);
		return st;
	};
	// on Windows the system normalizes a path lexically before it opens it,
	// so the lexical resolution is what a command opens there
	const at = (cwd: string, t: string): string => (dialect.msys ? P.resolve(cwd, t) : t.startsWith("/") ? t : `${cwd}/${t}`);
	/** Windows P2: a word as Git Bash's command sees the path — or null
	 *  when it cannot be read (only its spelling can be checked). */
	const native = (t: string): string | null => {
		if (!dialect.msys) return t;
		const read = msysPath(t);
		return "opaque" in read ? null : read.native;
	};
	const regexes = new Map<string, RegExp>();
	const realOf = new Map<string, string>();
	/** Whether a word's last component is a protected file's name, or one
	 *  of its name-suffixed siblings'. */
	const named = (t: string): boolean => {
		const leaf = t.slice(t.lastIndexOf("/") + 1).toLowerCase();
		return names.some((n) => leaf === n || leaf.startsWith(`${n}.`));
	};

	const expand = (t: string, tilde: boolean): string => {
		let out = tilde && (t === "~" || t.startsWith("~/")) ? env.home + t.slice(1) : t;
		out = out.replace(/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, env.home);
		return out.replace(/\$\{KISO_HOME\}|\$KISO_HOME(?![A-Za-z0-9_])/g, env.kisoHome);
	};
	/** One literal-or-glob path text, read from each candidate directory. */
	const pathHits = (word: string, s: CdState): boolean => {
		if (word === "") return false;
		if (/[$`]/.test(word)) return namesProtected(word);
		const t = native(word);
		if (t === null) return namesProtected(word);
		if (s.lossy && !P.isAbsolute(t) && namesProtected(t)) return true;
		const glob = /[*?[]/.test(t);
		for (const cwd of s.cwds) {
			charge();
			if (!glob) {
				// by spelling first, which needs no disk (a sibling that does
				// not exist yet) — only when the last component could be the
				// file's name — then by inode
				if (named(t)) {
					const spelled = P.resolve(cwd, t).toLowerCase();
					if (paths.some((pf) => spelled === pf || spelled.startsWith(`${pf}.`))) return true;
				}
				const st = statAt(at(cwd, t));
				if (st?.isFile() === true && probe.files.has(inode(st))) return true;
				continue;
			}
			const g = t.search(/[*?[]/);
			const cut = t.lastIndexOf("/", g);
			const rest = t.slice(cut + 1);
			// only where the literal directory HOLDS a protected file — a glob
			// anywhere else is never expanded, and the disk is never walked
			const dirText = cut < 0 ? cwd : at(cwd, t.slice(0, cut + 1));
			const dst = statAt(dirText);
			if (dst?.isDirectory() !== true || !probe.dirs.has(inode(dst))) continue;
			// a `..` after the glob walks out of what the pattern can say
			if (/(^|\/)\.\.(\/|$)/.test(rest)) {
				if (namesProtected(t)) return true;
				continue;
			}
			let real = realOf.get(dirText);
			if (real === undefined) {
				try {
					real = realpathSync.native(dirText);
				} catch {
					continue;
				}
				realOf.set(dirText, real);
			}
			// Windows: one separator, one case, on both sides of the match
			const fold = (p: string): string => (dialect.msys ? p.replace(/\\/g, "/").toLowerCase() : p);
			const dirReal = fold(real);
			const pattern = `${dirReal.endsWith("/") ? dirReal : `${dirReal}/`}${dialect.msys ? rest.toLowerCase() : rest}`;
			let re = regexes.get(pattern);
			if (re === undefined) regexes.set(pattern, (re = globRegex(pattern)));
			if (probe.targets.some((p) => re.test(fold(p)))) return true;
		}
		return false;
	};
	const wordHits = (w: LooseWord, s: CdState): boolean => {
		// `~name/…` is another account's home — or this one's, by name
		if (w.tilde && /^~[^/]/.test(w.text)) return namesProtected(w.text);
		const t = expand(w.text, w.tilde);
		if (pathHits(t, s)) return true;
		// `--config=path`, `if=path`, `X=path`: the value is a path too
		const eq = t.indexOf("=");
		return eq > 0 && pathHits(expand(t.slice(eq + 1), t[eq + 1] === "~"), s);
	};
	/** A directory holding a protected file — the file's own, or any
	 *  directory above it — by inode. */
	const holds = (w: LooseWord, s: CdState): boolean => {
		const spelled = expand(w.text, w.tilde);
		if (spelled === "" || /[$`*?[]/.test(spelled) || (w.tilde && /^~[^/]/.test(w.text))) return false;
		const t = native(spelled);
		if (t === null) return false;
		return s.cwds.some((cwd) => {
			charge();
			const st = statAt(at(cwd, t));
			return st?.isDirectory() === true && probe.dirs.has(inode(st));
		});
	};
	/** One command naming a directory that holds a protected file AND that
	 *  file's name, in two words: `find ~/.kiso -name auth.json`. */
	const dirAndName = (words: readonly LooseWord[], s: CdState): string | null => {
		const named = words.find((w) => namesProtected(w.text));
		return named !== undefined && words.some((w) => w !== named && holds(w, s)) ? named.text : null;
	};

	const seen = new Set<string>();
	let cds = 0;
	// a nest past what the check follows is thrown, not returned: it ends
	// the whole read, and must never read as a word
	const walk = (nodes: readonly LooseNode[], s: CdState, depth: number): string | null => {
		for (const node of nodes) {
			// after `cd x`: `&&` runs in x, `||` where it was, `;` in either
			if (s.pending !== null) {
				s.cwds = cap(s, node.joinedBy === "&&" ? s.pending : node.joinedBy === "||" ? s.cwds : [...s.pending, ...s.cwds]);
				if (node.joinedBy !== "&&") s.pending = null;
			}
			if (node.kind === "group") {
				// a subshell: its cd does not move the shell around it
				const hit = walk(node.items, child(s), depth);
				if (hit !== null) return hit;
				continue;
			}
			// every word the command names, its own name included, and the
			// words the floor drops (`< file`, `2> file`, `X=file`)
			const words = [...node.argv, ...(node.dropped ?? [])];
			for (const w of words) if (wordHits(w, s)) return w.text;
			const pair = dirAndName(words, s);
			if (pair !== null) return pair;
			const argv = unwrap(node.argv);
			if (argv.length === 0) continue;
			const inner = innerLines(argv, env.home);
			if (inner !== null) {
				if (depth >= MAX_INNER_DEPTH) throw new Unread(NESTED_TOO_DEEP);
				for (const l of inner.lines) {
					if (seen.has(l)) continue;
					if (seen.size >= MAX_INNER_LINES) throw new Unread(NESTED_TOO_DEEP);
					seen.add(l);
					const read = parseShellLooseChecked(l, { keepDropped: true });
					if (read.truncated) throw new Unread(NESTED_TOO_DEEP);
					// `sh -c` is a child shell; eval runs here, and its cd moves this one
					const hit = walk(read.nodes, inner.subshell ? child(s) : s, depth + 1);
					if (hit !== null) return hit;
				}
				continue;
			}
			const name = basename(argv[0]!.text);
			if (name === "cd" || name === "pushd" || name === "popd") {
				if (++cds > MAX_CDS) throw new Unread(TOO_MANY_CDS);
				const to = argv.slice(1).find((a) => !["--", "-P", "-L", "-e", "-@"].includes(a.text));
				if (name === "popd" || to?.text === "-") {
					// back to somewhere the check does not track
					s.lossy = true;
					s.pending = cap(s, [...s.cwds, env.home, workspaceRoot]);
				} else if (to === undefined) s.pending = [env.home];
				else {
					const spelled = expand(to.text, to.tilde);
					const t = native(spelled);
					if (t === null || /[$`*?[]/.test(spelled) || (to.tilde && /^~[^/]/.test(to.text))) {
						s.lossy = true;
						s.pending = cap(s, [env.home, ...s.cwds]);
					} else s.pending = cap(s, s.cwds.map((c) => at(c, t)));
				}
			}
		}
		return null;
	};
	const top = parseShellLooseChecked(line, { keepDropped: true });
	if (top.truncated) return { hit: true, why: NESTED_TOO_DEEP, unread: true };
	try {
		const hit = walk(top.nodes, { cwds: [workspaceRoot], lossy: false, pending: null }, 0);
		return hit === null ? { hit: false } : { hit: true, why: hit, unread: false };
	} catch (err) {
		if (err instanceof Unread) return { hit: true, why: err.message, unread: true };
		throw err;
	}
}

/** The refusal the MODEL reads. Permanent, as the file tools say it, so
 *  it does not retry under another spelling. */
export function protectedShellReason(v: { readonly why: string; readonly unread: boolean }): string {
	if (v.unread) return `${PROTECTED_REFUSAL}: ${v.why}, so kiso does not run it, in any mode.`;
	return `${PROTECTED_REFUSAL}: ${v.why} names a protected file. This is permanent, in every mode: do not retry it, under this path or another.`;
}

/** The refusal the PERSON reads, for their own `!` line: what to do
 *  instead. */
export function protectedBangReason(v: { readonly why: string; readonly unread: boolean }): string {
	return `not run — ${v.unread ? v.why : `${v.why} names a protected file`}. Run it in your own terminal: kiso never puts its credential store on a path to a model.`;
}

export type ProtectedShellCheck = typeof protectedShellCheck;

/** The whole question for one line, as both callers ask it. A line the
 *  check throws on is refused: a line it could not read is not a line it
 *  may let through. */
export function protectedShellVerdict(
	line: string,
	workspaceRoot: string,
	files: readonly string[],
	env: ProtectedShellEnv,
	check: ProtectedShellCheck = protectedShellCheck,
): { readonly refused: false } | { readonly refused: true; readonly why: string; readonly unread: boolean } {
	if (files.length === 0) return { refused: false };
	try {
		const v = check(line, workspaceRoot, protectedIdentity(files), env);
		return v.hit ? { refused: true, why: v.why, unread: v.unread } : { refused: false };
	} catch (err) {
		return { refused: true, why: `the check could not read this line (${err instanceof Error ? err.name : "error"})`, unread: true };
	}
}

/** The chain member: deny-or-abstain, every mode. */
export function protectedShellExtension(opts: {
	readonly files: () => readonly string[];
	readonly workspaceRoot: () => string;
	readonly env: () => ProtectedShellEnv;
	readonly check?: ProtectedShellCheck;
}): KisoExtension {
	return {
		name: "protected-files",
		approvals: [
			{
				decide: (call) => {
					if (call.name !== "shell") return ABSTAIN;
					const command = (call.input as { command?: unknown }).command;
					if (typeof command !== "string") return ABSTAIN;
					const v = protectedShellVerdict(command, opts.workspaceRoot(), opts.files(), opts.env(), opts.check);
					return v.refused ? { action: "deny", reason: protectedShellReason(v) } : ABSTAIN;
				},
			},
		],
	};
}
