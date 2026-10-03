/**
 * 0.40.0 — the read-only shell allow (launch-weekend plan §3; the design
 * is kiso-doc plan-readonly-shell-2026-09-18).
 *
 * A shell call that can be PROVEN read-only runs without asking in the
 * asking modes. "Proven" is the whole contract: this module answers
 * `allow` only for a command line it has read completely — every segment
 * of every pipeline a command on the table below, every flag on that
 * command's list, every path inside the workspace, every redirection one
 * of the few that write nothing — and `abstain` for everything else. It
 * never asks and never denies, so anything it does not understand meets
 * exactly the approval it met before this module existed.
 *
 * Flags are ALLOW-listed per command. A deny-list of the dangerous ones
 * would be a list of the dangerous ones known on the day it was written:
 * rg grew `--hostname-bin` (which runs a program) long after `--pre`.
 *
 * Two path predicates, one resolver (`resolveShellPath`, shared with the
 * floor):
 *  - SCOPE, for every path: the canonical path — symlinks followed — is
 *    the workspace or under it, read_file's rule;
 *  - CONTENT, for a path whose bytes the command prints: scope, and not a
 *    credential by name (`isCredentialName`, the search corpus's rule).
 *    Stricter than read_file, which reads `.env` on purpose; a shell read
 *    of one asks.
 *
 * Recursive search is deliberately NOT on the table (grep -r, rg over a
 * directory). search_text is allowed unasked BECAUSE its walk skips
 * credential files; rg skips hidden files but reads `id_rsa` and `*.pem`,
 * and grep -r reads everything, so an unasked search for "KEY" would hand
 * a private key to the provider. The model has search_text for that.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PolicyVerdict } from "@vincemakes/kiso-core";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { isCredentialName, isCredentialPath } from "@vincemakes/kiso-tools-node";
import { getMode, type Mode } from "./mode.js";
import { homeSubtrees, hostDialect, parseShell, realCase, resolveShellPath, type Redirect, type SimpleCommand } from "./shell-words.js";

export type ReadOnlyVerdict = { readonly allow: true } | { readonly allow: false; readonly why: string };

interface Ctx {
	readonly root: string;
	/** Canonical directories whose files are never read unasked, wherever
	 *  the workspace is — kiso's own home, with the credential store in it,
	 *  when the workspace is the user's home directory (DC-49). */
	readonly protectedRoots: readonly string[];
	/** Every directory the command might be running in — a `cd` that fails
	 *  leaves the old one, so a path must hold from all of them. */
	readonly cwds: readonly string[];
	/** The command's place in its pipeline: past the first, stdin is the
	 *  previous command's output. */
	readonly stage: number;
}

// ── the predicates ──────────────────────────────────────────────────────

function scope(ctx: Ctx, word: string): string | null {
	if (word === "-") return null; // stdin
	for (const cwd of ctx.cwds) {
		const { canonical, inside, opaque } = resolveShellPath(ctx.root, cwd, word);
		if (opaque !== undefined) return `${word} is ${opaque}`;
		if (!inside) return `${word} is outside the workspace`;
		// B4: under a protected directory NOTHING is read or listed unasked —
		// kiso's own home, and ~/.ssh ~/.config ~/.aws ~/.gnupg ~/.kiso when
		// the workspace is the home directory. Over-asking is an ask.
		for (const p of ctx.protectedRoots) {
			const rel = hostDialect().path.relative(p, canonical);
			if (rel === "" || (!rel.startsWith("..") && !hostDialect().path.isAbsolute(rel))) return `${word} is inside a protected directory (${p})`;
		}
	}
	return null;
}

/** B4, and since RO-F4 (0.40.7) the search corpus's own set: the shell and
 *  the file tools ask ONE rule — names (`isCredentialName`) and the
 *  directory-scoped paths (`isCredentialPath`) — on the canonical path. */
function shellCredential(canonical: string): boolean {
	return isCredentialName(hostDialect().path.basename(canonical).toLowerCase()) || isCredentialPath(canonical);
}

function content(ctx: Ctx, word: string): string | null {
	const s = scope(ctx, word);
	if (s !== null) return s;
	if (word === "-") return null;
	// B2: the disk is case-insensitive and the names are not — `.ENV` and
	// `ID_RSA` are `.env` and `id_rsa` to the file system, so to the rule
	if (isCredentialName(hostDialect().path.basename(word).toLowerCase())) return `${word} is a credential file`;
	for (const cwd of ctx.cwds) {
		const { canonical } = resolveShellPath(ctx.root, cwd, word);
		if (isCredentialName(hostDialect().path.basename(canonical).toLowerCase()) || shellCredential(canonical)) return `${word} leads to a credential file`;
	}
	return null;
}

/** For rg: a directory operand makes it recurse, and so does none. */
function regularFile(ctx: Ctx, word: string): string | null {
	const c = content(ctx, word);
	if (c !== null) return c;
	for (const cwd of ctx.cwds) {
		try {
			if (statSync(resolveShellPath(ctx.root, cwd, word).canonical).isDirectory()) return `${word} is a directory (a recursive search)`;
		} catch {
			// a missing file: the command fails on its own
		}
	}
	return null;
}

// ── option parsing ──────────────────────────────────────────────────────

interface Opts {
	/** Short letters that take no value; they may be combined (`-la`). */
	readonly short?: string;
	/** Short letters that take a value, attached (`-n5`) or next (`-n 5`). */
	readonly shortArg?: string;
	readonly long?: readonly string[];
	/** Long options that REQUIRE a value, getopt_long style: `--lines=5`
	 *  or `--lines 5` — the next argument is consumed. */
	readonly longArg?: readonly string[];
	/** Long options whose value is OPTIONAL and therefore only ever
	 *  attached (`--color`, `--color=never`): the next argument is never
	 *  consumed, so it is still checked as an operand. */
	readonly longOptArg?: readonly string[];
	/** `-5` as a count. */
	readonly numeric?: boolean;
	/** Short tokens accepted whole by pattern (`-uno`, `-M50%`). */
	readonly shortPatterns?: readonly RegExp[];
}

interface ParsedOk {
	readonly operands: string[];
	readonly values: Map<string, string[]>;
}
interface ParseRefused {
	readonly why: string;
}
type Parsed = ParsedOk | ParseRefused;

/** Walk the arguments against an option spec. Every option must be on it;
 *  operands are returned for the command's own checks. Options after
 *  operands are still checked as options — stricter than a BSD tool, which
 *  would take them as operands, and never looser. */
function parseOpts(args: readonly string[], spec: Opts): Parsed {
	const operands: string[] = [];
	const values = new Map<string, string[]>();
	const note = (k: string, v: string): void => {
		values.set(k, [...(values.get(k) ?? []), v]);
	};
	let i = 0;
	let rest = false;
	while (i < args.length) {
		const a = args[i]!;
		i += 1;
		if (rest || a === "-" || !a.startsWith("-")) {
			operands.push(a);
			continue;
		}
		if (a === "--") {
			rest = true;
			continue;
		}
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
			if (spec.longArg?.includes(name)) {
				if (eq >= 0) note(name, a.slice(eq + 1));
				else {
					if (i >= args.length) return { why: `--${name} needs a value` };
					note(name, args[i]!);
					i += 1;
				}
				continue;
			}
			if (spec.longOptArg?.includes(name)) {
				if (eq >= 0) note(name, a.slice(eq + 1));
				continue;
			}
			if (spec.long?.includes(name) && eq < 0) continue;
			return { why: `the option --${name}` };
		}
		if (spec.numeric === true && /^-\d+$/.test(a)) continue;
		if (spec.shortPatterns?.some((re) => re.test(a))) continue;
		let j = 1;
		while (j < a.length) {
			const f = a[j]!;
			if (spec.short?.includes(f)) {
				j += 1;
				continue;
			}
			if (spec.shortArg?.includes(f)) {
				const attached = a.slice(j + 1);
				if (attached !== "") note(f, attached);
				else {
					if (i >= args.length) return { why: `-${f} needs a value` };
					note(f, args[i]!);
					i += 1;
				}
				j = a.length;
				continue;
			}
			return { why: `the option -${f}` };
		}
	}
	return { operands, values };
}

const failed = (p: Parsed): p is ParseRefused => "why" in p;

/** Options only; the operands need no check of their own. */
function optionsOnly(args: readonly string[], spec: Opts): string | null {
	const p = parseOpts(args, spec);
	return failed(p) ? p.why : null;
}

/** Parse, then run `check` on every operand. */
function operandsAll(args: readonly string[], spec: Opts, check: (w: string) => string | null): string | null {
	const p = parseOpts(args, spec);
	if (failed(p)) return p.why;
	for (const w of p.operands) {
		const e = check(w);
		if (e !== null) return e;
	}
	return null;
}

// ── the table ───────────────────────────────────────────────────────────

type Rule = (args: readonly string[], ctx: Ctx) => string | null;

const HEAD_TAIL: Opts = { short: "qvr", shortArg: "nc", long: ["quiet", "silent", "verbose"], longArg: ["lines", "bytes"], numeric: true };

const LOG_LIKE_LONG = [
	"oneline", "graph", "decorate", "all", "branches", "tags", "remotes", "stat", "shortstat", "numstat", "name-only", "name-status",
	"patch", "no-patch", "follow", "reverse", "no-merges", "merges", "first-parent", "abbrev-commit", "no-abbrev", "no-color",
	"cached", "staged", "minimal", "patience", "histogram", "check", "summary", "full-index", "binary", "text", "raw", "no-renames",
	"merge-base", "exit-code", "quiet", "no-index", "compact-summary", "left-right", "cherry-pick", "cherry-mark", "boundary",
	"topo-order", "date-order", "author-date-order", "simplify-by-decoration", "source", "no-notes", "full-diff", "parents",
	"children", "no-prefix", "mailmap", "no-mailmap", "use-mailmap", "regexp-ignore-case", "invert-grep", "all-match",
	"ignore-all-space", "ignore-space-change", "ignore-blank-lines", "ignore-space-at-eol", "relative", "no-relative",
	"no-textconv", "no-ext-diff", "walk-reflogs", "remerge-diff", "no-diff-merges", "cc", "expand-tabs", "no-expand-tabs", "log-size",
	"no-decorate",
];
/** Every git option that takes a value, accepted ONLY attached
 *  (`--author=x`). git consumes the next argument for some of these when
 *  the value is not attached; taking none of them that way means the next
 *  argument is always checked as an operand here — never looser than git. */
const LOG_LIKE_VALUED = [
	"format", "pretty", "since", "after", "until", "before", "author", "committer", "grep", "date", "abbrev", "color", "max-count",
	"skip", "unified", "word-diff-regex", "diff-filter", "stat-width", "stat-name-width", "encoding", "diff-merges", "line-prefix",
	"src-prefix", "dst-prefix", "decorate-refs", "decorate-refs-exclude", "submodule", "decorate", "stat", "word-diff",
	"find-renames", "find-copies", "dirstat", "relative", "color-words",
];
/** Short forms for log/show/diff, taken whole. A bare `-n`, `-U`, `-S`,
 *  `-G` consumes nothing here, so its value is checked as an operand (a
 *  count or a search string resolves inside). `-L` (a range in a FILE) and
 *  `-O` (an orderfile) are not here: both name a path inside another
 *  argument, where the resolver would not find it. */
const LOG_LIKE_SHORT = [/^-\d+$/, /^-[puswiEFPbzRWaqmctr]+$/, /^-[MCB](\d+%?)?$/, /^-[nUSG]$/, /^-[nU]\d+$/, /^-[SG].+$/];

function gitLogLike(args: readonly string[], ctx: Ctx): string | null {
	const spec: Opts = { long: LOG_LIKE_LONG, longOptArg: LOG_LIKE_VALUED, shortPatterns: LOG_LIKE_SHORT };
	const noIndex = args.includes("--no-index");
	// B3 (the lead's review): these PRINT what they name — `git diff .env`,
	// `git log -p -- .env`, `git show HEAD:.env` — so an operand takes the
	// CONTENT predicate, not only the scope one. A revision resolves to a
	// path that does not exist and passes; in `rev:path` the path is what
	// is printed. Pathspec MAGIC (`:(top)x`, `:/x`) is read by git, not by
	// this resolver. `--no-index` over a directory compares every file in
	// it. Stated residual, not refused: `git log -p` / `git show` with no
	// pathspec prints every tracked file — a committed credential is the
	// repository's own exposure.
	return operandsAll(args, spec, (w) => {
		if (w.startsWith(":")) return `the pathspec ${w}`;
		const colon = w.indexOf(":");
		const path = colon > 0 ? w.slice(colon + 1) : w;
		if (path === "") return null;
		if (noIndex) {
			for (const cwd of ctx.cwds) {
				try {
					if (statSync(resolveShellPath(ctx.root, cwd, path).canonical).isDirectory()) return `git diff --no-index over the directory ${path}`;
				} catch {
					// missing: git fails on its own
				}
			}
		}
		return content(ctx, path);
	});
}

function gitBranch(args: readonly string[]): string | null {
	const takesCommit = ["merged", "no-merged", "contains", "no-contains", "points-at"];
	const p = parseOpts(args, {
		short: "arvl",
		long: ["all", "remotes", "verbose", "list", "show-current", "no-color", "no-column", "ignore-case", "omit-empty", ...takesCommit],
		longOptArg: ["sort", "format", "color", "column"],
	});
	if (failed(p)) return p.why;
	// The LIST forms only. A positional is a pattern after --list/-l, or
	// the commit of a filter option; anywhere else it names a branch to
	// CREATE (`git branch x`) — and -d/-m/-c/-f/-u are simply not listed.
	const listing = args.includes("--list") || args.some((a) => /^-[arv]*l[arv]*$/.test(a));
	const filters = args.filter((a) => takesCommit.includes(a.replace(/^--/, ""))).length;
	if (!listing && p.operands.length > filters) return "git branch with a name creates a branch";
	return null;
}

const GIT_SUB: Readonly<Record<string, Rule>> = {
	status: (args, ctx) =>
		operandsAll(
			args,
			{
				short: "sbvz",
				long: ["short", "branch", "long", "verbose", "no-column", "ahead-behind", "no-ahead-behind", "renames", "no-renames", "show-stash"],
				longOptArg: ["porcelain", "ignored", "untracked-files", "column"],
				shortPatterns: [/^-u(no|normal|all)?$/],
			},
			(w) => (w.startsWith(":") ? `the pathspec ${w}` : scope(ctx, w)),
		),
	log: gitLogLike,
	show: gitLogLike,
	diff: gitLogLike,
	branch: (args) => gitBranch(args),
	// Operands are revisions; a `rev:path` is resolved inside the repository.
	"rev-parse": (args) =>
		optionsOnly(args, {
			short: "q",
			long: ["show-toplevel", "verify", "quiet", "git-dir", "absolute-git-dir", "git-common-dir", "is-inside-work-tree", "is-inside-git-dir", "is-bare-repository", "show-prefix", "show-cdup", "symbolic", "symbolic-full-name", "show-superproject-working-tree"],
			longOptArg: ["abbrev-ref", "short"],
		}),
	"ls-files": (args, ctx) =>
		operandsAll(
			args,
			{
				short: "cdmoiskutvz",
				long: ["cached", "deleted", "modified", "others", "ignored", "stage", "unmerged", "killed", "exclude-standard", "directory", "no-empty-directory", "full-name", "error-unmatch", "recurse-submodules", "eol", "debug"],
				longOptArg: ["exclude", "abbrev"],
			},
			(w) => (w.startsWith(":") ? `the pathspec ${w}` : scope(ctx, w)),
		),
};

function git(args: readonly string[], ctx: Ctx): string | null {
	let i = 0;
	let cwds = ctx.cwds;
	// Global options. `-c` is config injection — `-c core.fsmonitor=cmd`
	// runs `cmd` on `git status` — and --git-dir/--work-tree/--exec-path
	// move git somewhere this resolver did not look; none is listed.
	while (i < args.length && args[i]!.startsWith("-")) {
		const a = args[i]!;
		if (a === "--no-pager" || a === "-P" || a === "--no-optional-locks") {
			i += 1;
			continue;
		}
		if (a === "-C" && i + 1 < args.length) {
			const dir = args[i + 1]!;
			const s = scope({ ...ctx, cwds }, dir);
			if (s !== null) return s;
			cwds = cwds.map((c) => resolveShellPath(ctx.root, c, dir).canonical);
			i += 2;
			continue;
		}
		if (a === "--version" && args.length === 1) return null;
		return `the git option ${a}`;
	}
	const sub = args[i];
	if (sub === undefined) return "git with no subcommand";
	const rule = GIT_SUB[sub];
	if (rule === undefined) return `git ${sub} is not read-only here`;
	return rule(args.slice(i + 1), { ...ctx, cwds });
}

function find(args: readonly string[], ctx: Ctx): string | null {
	let i = 0;
	// BSD options before the paths; -L/-H follow symbolic links out.
	while (i < args.length && /^-[Exsd]+$/.test(args[i]!)) i += 1;
	while (i < args.length && !args[i]!.startsWith("-") && args[i] !== "!" && args[i] !== "(" && args[i] !== ")") {
		const s = scope(ctx, args[i]!);
		if (s !== null) return s;
		i += 1;
	}
	const noArg = new Set(["-print", "-print0", "-prune", "-empty", "-not", "!", "-o", "-a", "-and", "-or", "(", ")", "-ls", "-depth", "-d", "-true", "-false", "-readable", "-writable", "-executable", "-nouser", "-nogroup", "-xdev", "-mount", "-quit"]);
	const oneArg = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-type", "-maxdepth", "-mindepth", "-size", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin", "-regex", "-iregex", "-perm", "-user", "-group", "-links", "-printf"]);
	const fileArg = new Set(["-newer", "-samefile"]);
	while (i < args.length) {
		const a = args[i]!;
		if (noArg.has(a)) {
			i += 1;
			continue;
		}
		if (oneArg.has(a) || fileArg.has(a)) {
			if (i + 1 >= args.length) return `${a} needs a value`;
			if (fileArg.has(a)) {
				const s = scope(ctx, args[i + 1]!);
				if (s !== null) return s;
			}
			i += 2;
			continue;
		}
		// -exec -execdir -ok -okdir -delete -fprint* -fls -follow, and any
		// primary this table does not know
		return `the find primary ${a}`;
	}
	return null;
}

function grep(args: readonly string[], ctx: Ctx): string | null {
	const p = parseOpts(args, {
		short: "ivnclLwxohHsqEFGPaIzZbU",
		shortArg: "eABCm",
		numeric: true,
		long: ["ignore-case", "invert-match", "line-number", "count", "files-with-matches", "files-without-match", "word-regexp", "line-regexp", "only-matching", "no-filename", "with-filename", "no-messages", "quiet", "silent", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "text", "null", "null-data", "byte-offset", "line-buffered"],
		longArg: ["regexp", "after-context", "before-context", "context", "max-count", "binary-files", "label"],
		longOptArg: ["color", "colour"],
	});
	if (failed(p)) return p.why;
	// No -r/-R/-d: see the header. The first operand is the pattern unless
	// -e gave one.
	const files = p.values.has("e") || p.values.has("regexp") ? p.operands : p.operands.slice(1);
	for (const w of files) {
		const e = content(ctx, w);
		if (e !== null) return e;
	}
	return null;
}

function rg(args: readonly string[], ctx: Ctx): string | null {
	if (args.length === 1 && args[0] === "--version") return null;
	// `rg --files [dir]` lists NAMES under the ignore rules, reads no content
	if (args[0] === "--files") return operandsAll(args.slice(1), {}, (w) => scope(ctx, w));
	const p = parseOpts(args, {
		short: "iSswxnNlcvFoHIUP0q",
		shortArg: "etTABCmgM",
		long: ["ignore-case", "smart-case", "case-sensitive", "word-regexp", "line-regexp", "line-number", "no-line-number", "files-with-matches", "files-without-match", "count", "count-matches", "invert-match", "fixed-strings", "only-matching", "no-filename", "with-filename", "no-heading", "heading", "json", "vimgrep", "column", "trim", "multiline", "multiline-dotall", "pcre2", "null", "stats", "quiet", "no-messages", "byte-offset", "passthru"],
		longArg: ["regexp", "type", "type-not", "after-context", "before-context", "context", "max-count", "glob", "iglob", "color", "colors", "sort", "sortr", "max-columns", "replace", "encoding", "max-filesize"],
	});
	if (failed(p)) return p.why;
	const files = p.values.has("e") || p.values.has("regexp") ? p.operands : p.operands.slice(1);
	// S1: past a pipeline's first command, rg with no file reads stdin
	if (files.length === 0) return ctx.stage > 0 ? null : "rg with no file searches the whole tree";
	for (const w of files) {
		const e = regularFile(ctx, w);
		if (e !== null) return e;
	}
	return null;
}

function tail(args: readonly string[], ctx: Ctx): string | null {
	// -f/-F/--follow never return; they are simply not listed.
	return operandsAll(args, HEAD_TAIL, (w) => (/^\+\d+$/.test(w) ? null : content(ctx, w)));
}

const VERSION_ONLY = new Set(["--version"]);
const version =
	(...forms: string[]): Rule =>
	(args) =>
		args.length === 1 && (VERSION_ONLY.has(args[0]!) || forms.includes(args[0]!)) ? null : "only the version query is read-only";

const TABLE: Readonly<Record<string, Rule>> = {
	ls: (args, ctx) =>
		operandsAll(
			args,
			{
				shortPatterns: [/^-[A-Za-z1@%,]+$/],
				long: ["all", "almost-all", "human-readable", "recursive", "reverse", "directory", "inode", "numeric-uid-gid", "size", "si", "literal", "dereference", "full-time", "escape", "file-type", "no-group", "kibibytes", "author", "ignore-backups", "context", "zero", "group-directories-first"],
				longArg: ["sort", "time", "format", "ignore", "hide", "indicator-style", "width", "quoting-style", "time-style", "block-size"],
				longOptArg: ["color", "classify", "hyperlink"],
			},
			(w) => scope(ctx, w),
		),
	cat: (args, ctx) =>
		operandsAll(args, { short: "benstuvAET", long: ["number", "number-nonblank", "squeeze-blank", "show-all", "show-ends", "show-tabs", "show-nonprinting"] }, (w) => content(ctx, w)),
	head: (args, ctx) => operandsAll(args, HEAD_TAIL, (w) => content(ctx, w)),
	tail,
	wc: (args, ctx) =>
		operandsAll(args, { short: "lwcmL", long: ["lines", "words", "bytes", "chars", "max-line-length"] }, (w) => content(ctx, w)),
	pwd: (args) => (args.every((a) => a === "-L" || a === "-P") ? null : "pwd takes no operands"),
	which: (args) => optionsOnly(args, { short: "as" }),
	file: (args, ctx) =>
		operandsAll(args, { short: "bihLkNr0", long: ["brief", "mime", "mime-type", "mime-encoding", "dereference", "no-dereference", "keep-going", "raw", "print0"] }, (w) => scope(ctx, w)),
	stat: (args, ctx) => operandsAll(args, { short: "LnqrsxlF", shortArg: "fct", long: ["dereference", "terse", "file-system"], longArg: ["format", "printf"] }, (w) => scope(ctx, w)),
	du: (args, ctx) =>
		operandsAll(
			args,
			{ short: "shackmgxAHP0", shortArg: "dBI", long: ["summarize", "human-readable", "all", "total", "apparent-size", "one-file-system", "si", "null", "bytes"], longArg: ["max-depth", "exclude", "block-size", "threshold"] },
			(w) => scope(ctx, w),
		),
	// df reports filesystem usage and nothing else; its operands only pick
	// which filesystem, so they are not held to the workspace.
	df: (args) => optionsOnly(args, { short: "hkmgHilPTaY", shortArg: "tx", long: ["human-readable", "si", "inodes", "local", "portability", "print-type", "all", "total"], longArg: ["type", "exclude-type", "block-size"], longOptArg: ["output"] }),
	find,
	tree: (args, ctx) =>
		operandsAll(
			args,
			// -o writes a file; -R and -H write per-directory HTML; -l follows
			// links out; --fromfile reads a listing. None is listed.
			{
				short: "adfiqNQpugshDFrtcvUCnASJX",
				shortArg: "LIP",
				long: ["noreport", "gitignore", "dirsfirst", "du", "si", "prune", "matchdirs", "ignore-case", "inodes", "device"],
				longArg: ["filelimit", "charset", "sort", "timefmt"],
			},
			(w) => scope(ctx, w),
		),
	grep,
	rg,
	git,
	// Version queries: the program runs, and only prints what it is. npx is
	// not here — it can fetch a package to answer.
	node: version("-v"),
	npm: (args, ctx) => {
		if (args[0] === "ls" || args[0] === "list") {
			return optionsOnly(args.slice(1), { short: "aglps", long: ["all", "json", "long", "parseable", "prod", "production", "dev", "global", "link", "unicode", "silent"], longArg: ["depth", "omit", "include"] });
		}
		return version("-v")(args, ctx);
	},
	pnpm: version("-v"),
	yarn: version("-v"),
	bun: version("-v"),
	deno: version("-V"),
	python: version("-V"),
	python3: version("-V"),
	pip: version("-V"),
	pip3: version("-V"),
	cargo: version("-V"),
	rustc: version("-V"),
	go: (args) => (args.length === 1 && args[0] === "version" ? null : "only `go version` is read-only"),
	// Pipeline filters.
	sort: (args, ctx) =>
		operandsAll(
			args,
			// -o/--output write; --compress-program RUNS one; -T/--files0-from
			// point elsewhere. None is listed.
			{ short: "rnufhVbdiMRszcCg", shortArg: "kt", long: ["reverse", "numeric-sort", "unique", "ignore-case", "human-numeric-sort", "version-sort", "stable", "zero-terminated", "general-numeric-sort", "month-sort", "random-sort", "check", "dictionary-order", "ignore-leading-blanks"], longArg: ["key", "field-separator"] },
			(w) => content(ctx, w),
		),
	uniq: (args, ctx) => {
		const p = parseOpts(args, { short: "cdui", shortArg: "fsw", long: ["count", "repeated", "unique", "ignore-case"], longArg: ["skip-fields", "skip-chars", "check-chars"] });
		if (failed(p)) return p.why;
		// a SECOND operand is the output file
		if (p.operands.length > 1) return "uniq with an output file";
		return p.operands.length === 1 ? content(ctx, p.operands[0]!) : null;
	},
	cut: (args, ctx) => operandsAll(args, { short: "snz", shortArg: "bcfd", long: ["complement", "only-delimited", "zero-terminated"], longArg: ["bytes", "characters", "fields", "delimiter", "output-delimiter"] }, (w) => content(ctx, w)),
	tr: (args) => optionsOnly(args, { short: "dscCu" }),
	// NOT echo: it reads nothing, and the approval gates use `echo x` as
	// their command that asks.
};

/** The table's commands — the gate that every one has a case reads this. */
export const READ_ONLY_COMMANDS: readonly string[] = Object.keys(TABLE);

// ── redirections ────────────────────────────────────────────────────────

function redirect(r: Redirect, ctx: Ctx): string | null {
	if ((r.op === ">" || r.op === ">>") && (r.fd === null || r.fd === 1 || r.fd === 2 || r.fd === "&") && r.target === "/dev/null") return null;
	if (r.op === ">&" && (r.fd === null || r.fd === 1 || r.fd === 2) && (r.target === "1" || r.target === "2")) return null;
	if (r.op === "<" && (r.fd === null || r.fd === 0)) return content(ctx, r.target);
	return `a redirection to ${r.target}`;
}

function command(cmd: SimpleCommand, ctx: Ctx): string | null {
	for (const r of cmd.redirects) {
		const e = redirect(r, ctx);
		if (e !== null) return e;
	}
	const [name, ...args] = cmd.argv;
	const rule = name !== undefined && Object.hasOwn(TABLE, name) ? TABLE[name] : undefined;
	if (rule === undefined) return `${name ?? "?"} is not on the read-only table`;
	return rule(args, ctx);
}

/**
 * Is this command line read-only, provably? `workspaceRoot` is the
 * shell's working directory (the shell tool runs every command there);
 * nothing under `protectedRoots` is read unasked.
 */
export function classifyReadOnly(commandLine: string, workspaceRoot: string, protectedRoots: readonly string[] = []): ReadOnlyVerdict {
	const parsed = parseShell(commandLine);
	if (!parsed.ok) return { allow: false, why: parsed.why };
	const canonicalProtected = protectedRoots.map(realCase);
	let cwds: readonly string[] = [workspaceRoot];
	// S2: where the next command runs after `cd x` depends on the joiner —
	// `&&` only if the cd worked (x), `||` only if it failed (where it was),
	// `;` either. Held until a joiner other than `&&` settles it.
	// the `as` keeps the flow type the full union (a closure-free loop
	// otherwise narrows it to null for good)
	let lastCd = null as { readonly to: readonly string[]; readonly from: readonly string[] } | null;
	for (const pipeline of parsed.list) {
		if (lastCd !== null) {
			cwds = pipeline.joinedBy === "&&" ? lastCd.to : pipeline.joinedBy === "||" ? lastCd.from : [...new Set([...lastCd.to, ...lastCd.from])];
			if (pipeline.joinedBy !== "&&") lastCd = null;
		}
		const ctx: Ctx = { root: workspaceRoot, protectedRoots: canonicalProtected, cwds, stage: 0 };
		const first = pipeline.stages[0]!;
		if (first.argv[0] === "cd") {
			// `cd DIR` on its own, into the workspace
			if (pipeline.stages.length !== 1 || first.argv.length !== 2 || first.redirects.length > 0) return { allow: false, why: "a cd that is not `cd DIR` on its own" };
			const dir = first.argv[1]!;
			if (dir.startsWith("-")) return { allow: false, why: `cd ${dir}` };
			const s = scope(ctx, dir);
			if (s !== null) return { allow: false, why: s };
			lastCd = { to: [...new Set(cwds.map((c) => resolveShellPath(workspaceRoot, c, dir).canonical))], from: lastCd?.from ?? cwds };
			continue;
		}
		for (const [stage, cmd] of pipeline.stages.entries()) {
			const e = command(cmd, { ...ctx, stage });
			if (e !== null) return { allow: false, why: e };
		}
	}
	return { allow: true };
}

/** The modes in which a provable read runs unasked — with the don't-ask
 *  switch on too: an allow is what it still honours. Manual promises that
 *  every tool asks; plan denies shell outright; full-access allows
 *  everything already — this member has nothing to add to any of them. */
const ALLOWING_MODES: ReadonlySet<Mode> = new Set<Mode>(["default", "accept-edits"]);

const ABSTAIN: PolicyVerdict = { action: "abstain" };

/**
 * The chain member. ALLOW or ABSTAIN, never anything else: an allow here
 * outranks the tier's ask (deny > allow > ask) and is recorded as
 * `decidedBy: "read-only-shell"`, so the audit says why a shell call ran
 * unasked; a deny anywhere — plan's, the breaker's, a user extension's —
 * still wins over it.
 */
export function readOnlyShellExtension(roots: () => { readonly workspaceRoot: string; readonly excludeRoots: readonly string[] }): KisoExtension {
	return {
		name: "read-only-shell",
		approvals: [
			{
				decide: (call) => {
					if (call.name !== "shell" || !ALLOWING_MODES.has(getMode())) return ABSTAIN;
					const command = call.input.command;
					if (typeof command !== "string") return ABSTAIN;
					const { workspaceRoot, excludeRoots } = roots();
					const protectedRoots = [...excludeRoots, ...homeSubtrees().map((s) => join(homedir(), s))];
					return classifyReadOnly(command, workspaceRoot, protectedRoots).allow ? { action: "allow" } : ABSTAIN;
				},
			},
		],
	};
}
