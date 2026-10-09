/**
 * THE SEARCH CORPUS — one definition of "which files a search may see",
 * shared by `search_text` and `list_dir`'s glob.
 *
 * They disagreed before this existed: `list_dir` listed every dot entry
 * and `search_text` skipped all of them. Two walkers is how that happens,
 * so there is one.
 *
 * The rule is the user's own declaration. A `.gitignore` FILE at the
 * workspace root switches the corpus on — not the presence of `.git`, and
 * the walk never goes up. A `.gitignore` is the declaration wherever the
 * repository root happens to be, which is what lets a monorepo
 * subdirectory carrying its own file be treated properly instead of being
 * penalised for not being a repository root; and `.git` says nothing the
 * file does not. With no declaration there is nothing to trust, so the
 * old conservative rule stands: every dot entry skipped.
 *
 * Two things are never searched, declaration or not:
 *
 *  - `.git`, which is machinery, not content.
 *  - the CREDENTIAL SET below — files whose conventional purpose is to
 *    hold credentials. A committed file is not a secret by the user's own
 *    declaration, so `.github/` and `.eslintrc` ARE searchable; but an
 *    incidental hit from a search for "KEY" is exposure without intent,
 *    and that is what this prevents. An explicit `read_file` of any of
 *    them is unchanged.
 *
 * `node_modules` is skipped unconditionally in both modes, as before. It
 * is not a declaration question: DC-54 measured 296,924 files under a home
 * directory, and a corpus that can reach a dependency tree is the freeze
 * that finding was about.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ignore, { type Ignore } from "ignore";

/** The walk stops here. `search_text` has always used 8; the glob inherits
 *  it so a pattern cannot reach deeper than a search can. */
export const CORPUS_MAX_DEPTH = 8;

/** THE CREDENTIAL SET — files whose CONVENTIONAL PURPOSE is to hold
 *  credentials. That class is the rule; the list is its application, and
 *  the next candidate is judged by the class rather than by resemblance.
 *  Changes to this list are RULINGS, not edits.
 *
 *  Enumerated rather than matched by prefix: `.env*` as a prefix would
 *  also swallow `.environment` and `.envoy.yaml`, which are ordinary
 *  files that happen to start the same way.
 *
 *  IN, and why:
 *    `.env`, `.env.*`   the convention itself
 *    `.envrc`           direnv — routinely `export AWS_SECRET_...`
 *    `.netrc`           machine credentials, by definition
 *    id_rsa, id_dsa,    private keys, by name. Their `.pub` counterparts
 *    id_ecdsa,          are different names and stay searchable, which is
 *    id_ed25519         correct: a public key is public.
 *    *.pem              the same, by extension
 *    `.npmrc`, `.pypirc`, `.git-credentials`, `.htpasswd` — RO-F4, the
 *                       owner's 0.40.7 ruling. `.npmrc` was OUT here ("tokens
 *                       in it are normally `${VAR}` placeholders") while the
 *                       read-only shell rule (0.40.0, B4) already called it a
 *                       credential: two lists that disagreed, so a search
 *                       exposed what `cat` asked about. One set now, used by
 *                       both; a literal `_authToken=` is common enough.
 *    and, by PATH (a name alone would be too broad — `config`,
 *    `credentials`): `.aws/credentials`, `.config/gh/hosts.yml`,
 *    `.docker/config.json`, `.kube/config` (isCredentialPath)
 *
 *  OUT, deliberately, so the omissions are decisions and not oversights:
 *    `*.key`    too many non-secret uses to be a credential by name
 *
 *  An explicit `read_file` of ANY of these is unchanged. Reading on
 *  purpose is the user's model doing what it was told; an incidental hit
 *  from a search for "KEY" is exposure without intent, and only the
 *  second is what this prevents. */
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template"]);
const CREDENTIAL_NAMES = new Set([".envrc", ".netrc", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc", ".git-credentials", ".htpasswd"]);
const CREDENTIAL_PATHS = ["/.aws/credentials", "/.config/gh/hosts.yml", "/.docker/config.json", "/.kube/config"];

/** RO-F4: the credential files named by their DIRECTORY as well — a path
 *  (absolute or root-relative), folded to lower case as a case-insensitive
 *  disk would. The read-only shell rule asks this same question. */
export function isCredentialPath(path: string): boolean {
	const folded = `/${path.split(sep).join("/")}`.toLowerCase();
	return CREDENTIAL_PATHS.some((s) => folded.endsWith(s));
}

export function isCredentialName(name: string): boolean {
	if (ENV_TEMPLATES.has(name)) return false;
	if (name === ".env" || name.startsWith(".env.")) return true;
	if (CREDENTIAL_NAMES.has(name)) return true;
	return name.endsWith(".pem");
}

export interface CorpusOptions {
	workspaceRoot: string;
	/** Default CORPUS_MAX_DEPTH. */
	maxDepth?: number;
	/** Stop after this many files. Default: no cap (search has its own
	 *  budget; the glob passes 200). */
	maxEntries?: number;
	/** DC-49 exclude roots — the user's own knob, unchanged. */
	isExcluded?: (fullPath: string) => boolean;
	/** Keep only these. Applied BEFORE the cap, so `maxEntries` bounds the
	 *  files returned and not the files walked past — capping the walk
	 *  first and filtering after would silently return fewer matches than
	 *  exist, which is the defect the cap note exists to prevent. */
	accept?: (workspaceRelative: string) => boolean;
	/** Start the walk here instead of at the root. The DECLARATION is still
	 *  read at `workspaceRoot` and paths are still relative to it. */
	walkFrom?: string;
	/** 0.47.2: stop after VISITING this many files, accepted or not — the
	 *  walk's own budget, beside `maxEntries`, which bounds what it returns.
	 *  A glob that matches little walked the whole tree under it: 11 s from
	 *  a home directory. Default: no cap. */
	maxVisited?: number;
	/** 0.47.2: the call's wall-clock deadline (epoch ms); the walk stops
	 *  between entries once it has passed. Default: none. */
	deadline?: number;
}

export interface CorpusWalk {
	/** Workspace-relative, POSIX-separated. */
	files: string[];
	/** The walk stopped descending somewhere. DIFFERENT from the cap: the
	 *  remedy is "the file is deeper than a search reaches", not "narrow
	 *  the directory". Reported separately, and never claimed when it did
	 *  not happen — a walk that silently returns less is the same defect
	 *  as a read that silently returns 200 lines. */
	cutByDepth: boolean;
	/** The entry cap was reached. */
	cutByCap: boolean;
	/** 0.47.2: the walk stopped at `maxVisited` files. */
	cutByVisits: boolean;
	/** 0.47.2: the walk stopped at its deadline. */
	cutByDeadline: boolean;
	/** The files visited, accepted or not. */
	visited: number;
}

/** One directory's `.gitignore`, and the directory it is relative to. */
export interface Layer {
	dir: string;
	matcher: Ignore;
}

export function readLayer(dir: string): Layer | null {
	let text: string;
	try {
		text = readFileSync(join(dir, ".gitignore"), "utf8");
	} catch {
		return null;
	}
	return { dir, matcher: ignore().add(text) };
}

/** Ignored by ANY ancestor's file, each tested against the path relative
 *  to the directory that declared it — which is what makes a nested
 *  `.gitignore` apply to its own subtree and not above it. */
export function ignoredBy(layers: readonly Layer[], full: string, isDir: boolean): boolean {
	for (const layer of layers) {
		const rel = relative(layer.dir, full).split(sep).join("/");
		if (rel === "" || rel.startsWith("../")) continue;
		if (layer.matcher.ignores(isDir ? `${rel}/` : rel)) return true;
	}
	return false;
}

/** The SHARED predicate. `search_text` walks its own tree (its walk is
 *  interleaved with the budget and the matcher) and `walkCorpus` walks
 *  here, but both ask THIS — which is the whole point of there being one
 *  corpus rather than two walkers that agree by coincidence. */
export function corpusSkips(declared: boolean, layers: readonly Layer[], full: string, name: string, isDir: boolean): boolean {
	if (name === "node_modules" || name === ".git") return true;
	if (isCredentialName(name) || isCredentialPath(full)) return true;
	if (!declared) return name.startsWith(".");
	return ignoredBy(layers, full, isDir);
}

/** The layers in force inside `dir`, given its parent's. */
export function layersEntering(dir: string, parent: readonly Layer[]): readonly Layer[] {
	const own = readLayer(dir);
	return own === null ? parent : [...parent, own];
}

export function walkCorpus(opts: CorpusOptions): CorpusWalk {
	const root = opts.workspaceRoot;
	const maxDepth = opts.maxDepth ?? CORPUS_MAX_DEPTH;
	const maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
	const maxVisited = opts.maxVisited ?? Number.POSITIVE_INFINITY;
	const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
	const rootLayer = readLayer(root);
	/** No declaration, nothing to trust: the pre-corpus rule, unchanged. */
	const declared = rootLayer !== null;

	const files: string[] = [];
	let cutByDepth = false;
	let cutByCap = false;
	let cutByVisits = false;
	let cutByDeadline = false;
	let visited = 0;
	const stopped = (): boolean => cutByCap || cutByVisits || cutByDeadline;

	const start = opts.walkFrom ?? root;
	// entering a subtree, the layers between root and it still apply
	let startLayers: readonly Layer[] = rootLayer === null ? [] : [rootLayer];
	if (start !== root) {
		let cur = root;
		for (const part of relative(root, start).split(sep).filter(Boolean)) {
			cur = join(cur, part);
			startLayers = layersEntering(cur, startLayers);
		}
	}

	// 0.48.0 (finding 0472-F2) — BREADTH-FIRST, files before directories.
	// The walk was depth-first in readdir order, so under a budget a deep
	// sibling directory spent it before a file one level up was looked at:
	// `Desktop/devv/` sorts before `Desktop/generations.ts`, and the owner's
	// glob for that file stopped inside devv. Level by level, each
	// directory's entries in name order and its files first, the budget cuts
	// the deepest part of the tree and never a file nearer the root.
	const queue: { dir: string; depth: number; layers: readonly Layer[] }[] = [{ dir: start, depth: 0, layers: startLayers }];
	for (let next = 0; next < queue.length && !stopped(); next += 1) {
		const { dir, depth, layers } = queue[next]!;
		if (Date.now() > deadline) {
			cutByDeadline = true;
			break;
		}
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue; // unreadable directory: skipped, as before
		}
		entries.sort(byName);
		const here = depth === 0 ? layers : layersEntering(dir, layers);
		const subdirs: { dir: string; depth: number; layers: readonly Layer[] }[] = [];
		for (const entry of entries) {
			if (stopped()) break;
			const name = entry.name;
			const full = join(dir, name);
			const isDir = entry.isDirectory();
			if (corpusSkips(declared, here, full, name, isDir)) continue;
			if (isDir) {
				if (opts.isExcluded?.(full) === true) continue;
				if (depth + 1 > maxDepth) {
					cutByDepth = true;
					continue;
				}
				subdirs.push({ dir: full, depth: depth + 1, layers: here });
				continue;
			}
			if (visited >= maxVisited) {
				cutByVisits = true;
				break;
			}
			visited += 1;
			// the clock is read every 256 files, not per file
			if ((visited & 255) === 0 && Date.now() > deadline) {
				cutByDeadline = true;
				break;
			}
			const rel = relative(root, full).split(sep).join("/");
			if (opts.accept !== undefined && !opts.accept(rel)) continue;
			if (files.length >= maxEntries) {
				cutByCap = true;
				break;
			}
			files.push(rel);
		}
		queue.push(...subdirs);
	}
	// what was walked, in an order that does not depend on the filesystem's
	// readdir: by path segments, which is a depth-first listing by name
	files.sort(bySegments);
	return { files, cutByDepth, cutByCap, cutByVisits, cutByDeadline, visited };
}

/** Directory entries by name, in UTF-16 code-unit order — the same on
 *  every platform, unlike readdir's own order (name order on APFS and
 *  NTFS, hash order on ext4). */
export function byName(a: { name: string }, b: { name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Workspace-relative POSIX paths by segment, each by code unit: `a/x`
 *  before `a-b` before `b`, which is the order a depth-first walk by name
 *  lists them in. */
export function bySegments(a: string, b: string): number {
	const x = a.split("/");
	const y = b.split("/");
	for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
		if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
	}
	return x.length - y.length;
}

/** A minimal glob → RegExp, anchored, over workspace-relative POSIX paths.
 *
 *  `*` any run except `/`, `?` one character except `/`, `**` any run
 *  including `/`. A leading `** /` (without the space) matches zero or
 *  more directories, so `**\/*.ts` finds a root-level `a.ts` — the
 *  behaviour people expect and the one a naive translation gets wrong by
 *  requiring at least one directory.
 *
 *  Everything else is literal, including the regex metacharacters a path
 *  can legally contain. */
export function globToRegExp(pattern: string): RegExp {
	let out = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const c = pattern[i]!;
		if (c === "*") {
			if (pattern[i + 1] === "*") {
				// `**/` spans zero or more directories; a bare `**` spans anything
				if (pattern[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else out += "[^/]*";
			continue;
		}
		if (c === "?") {
			out += "[^/]";
			continue;
		}
		out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${out}$`);
}
