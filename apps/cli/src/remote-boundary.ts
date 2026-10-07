/**
 * 0.46.2 — the remote boundary (owner-ratified 2026-10-06, rev 2 with the
 * review's amendments).
 *
 * Two families of shell command change state that other people share:
 *
 *  A. a destructive git push — history rewritten or refs removed:
 *     --force / -f, --force-with-lease, --force-if-includes, a refspec
 *     with a leading `+`, --mirror, --delete / -d, a deleting refspec
 *     (`:branch`), --prune. A dry run is exempt, read as git reads it: the
 *     last of -n / --dry-run / --no-dry-run wins, and git takes any
 *     unambiguous prefix of a long option, so `--mirr` is --mirror and
 *     `--no-dry` turns the dry run off. A prefix is read generously — a
 *     prefix git would reject as ambiguous costs a question, not a pass.
 *  B. a registry write — a package published, unpublished or deprecated,
 *     or a dist-tag moved: npm or pnpm with `publish`, `unpublish`,
 *     `deprecate`, or `dist-tag` / `dist-tags` with add (a, set, s) or rm
 *     (r, del, d, remove) — pnpm hands the last three to npm; yarn with
 *     `publish`, `npm publish`, or `tag` / `npm tag` with add, rm or
 *     remove. Not as the script `npm run publish` names. A dry run is
 *     exempt only where the command honours one, read as its parser reads
 *     it (`--dry-run false` is a real publish): npm and pnpm publish and
 *     unpublish take --dry-run, `yarn npm publish` takes -n / --dry-run;
 *     deprecate, dist-tag and yarn classic's publish have none, so the
 *     flag exempts nothing there. npm's abbreviations of a command
 *     (`npm pub`) are read too, in the command's place — not after an
 *     option that takes a value (`npm --registry x pub`). Listing tags
 *     and `npm view` stay out.
 *
 * A saved "don't ask again for shell" never carries either
 * (protected-writes.ts neverInheritedCall): permission remembered by TOOL
 * NAME from some earlier call does not cross into a change other people
 * share. Authority given now still does — every tier decides these as it
 * decides any shell call, so full-access runs them, and an explicit user
 * extension that allows them still allows them. That is the extension of
 * launch-weekend plan §4 ("destructive commands never inherit a saved
 * allow in the asking modes") to the remote; "bypass stays bypass" is
 * untouched.
 *
 * The list is closed: a new family needs the owner's word. It reads
 * direct invocations only, words as written — `npm run release`, a script
 * file, a git alias, a `+` refspec in git config and a variable's value
 * are not seen. A guardrail, not a sandbox. A line it cannot read is not
 * its question: isDestructiveCall already answers yes for one, so a saved
 * allow abstains either way, and the two readings never disagree on what
 * "unreadable" means.
 */

import { homedir } from "node:os";
import { basename } from "node:path";
import type { PolicyCall } from "@vincemakes/kiso-core";
import { MAX_INNER_DEPTH, MAX_INNER_LINES, gitInvocation, innerLines, unwrap } from "./floor.js";
import { looseCommands, parseShellLooseChecked, type LooseWord } from "./shell-words.js";

/** git push options that take the next word as their value. */
const PUSH_VALUED = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
/** git push options that rewrite or remove remote refs. */
const PUSH_REWRITES = new Set(["--force", "--force-with-lease", "--force-if-includes", "--mirror", "--delete", "--prune"]);

function destructivePush(args: readonly LooseWord[]): boolean {
	let crosses = false;
	let dryRun = false;
	let options = true;
	const positionals: string[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const t = args[i]!.text;
		if (!options || !t.startsWith("-") || t === "-") {
			positionals.push(t);
			continue;
		}
		if (t === "--") {
			options = false;
			continue;
		}
		if (PUSH_VALUED.has(t)) {
			i += 1;
			continue;
		}
		if (t.startsWith("--")) {
			const flag = t.split("=")[0]!;
			if (flag === "--dry-run") dryRun = true;
			else if (flag.length >= "--no-d".length && "--no-dry-run".startsWith(flag)) dryRun = false;
			else if (flag.length > 2 && [...PUSH_REWRITES].some((r) => r.startsWith(flag))) crosses = true;
			continue;
		}
		// a short cluster, `-uf`; `-o` takes the rest of the word, or the next
		for (let k = 1; k < t.length; k += 1) {
			const c = t[k];
			if (c === "o") {
				if (k === t.length - 1) i += 1;
				break;
			}
			if (c === "n") dryRun = true;
			if (c === "f" || c === "d") crosses = true;
		}
	}
	// the first positional is the repository; the rest are refspecs
	if (positionals.slice(1).some((r) => r.startsWith("+") || r.startsWith(":"))) crosses = true;
	return crosses && !dryRun;
}

/** Whether a dry run is on, read as npm's option parser reads it: the last
 *  setting wins, `--dry-run false` and `--dry-run=false` turn it off, and
 *  only an explicit true counts. `-n` is a dry run where yarn says so. */
function dryRun(words: readonly string[], short: boolean): boolean {
	let on = false;
	for (let i = 0; i < words.length; i += 1) {
		const w = words[i]!;
		if (w === "--dry-run" || (short && w === "-n")) {
			const next = words[i + 1];
			on = next !== "false";
			if (next === "true" || next === "false") i += 1;
		} else if (w.startsWith("--dry-run=")) on = w === "--dry-run=true";
		else if (w === "--no-dry-run") on = false;
	}
	return on;
}

/** dist-tag (npm) and tag (yarn) write with these subcommands, and list
 *  with the rest — a bare `npm dist-tag <pkg>` lists too. */
const NPM_TAG_WRITES = new Set(["add", "a", "set", "s", "rm", "r", "del", "d", "remove"]);
const NPM_TAG_READS = new Set(["ls", "l", "sl", "list"]);
const YARN_TAG_WRITES = new Set(["add", "rm", "remove"]);
const YARN_TAG_READS = new Set(["ls", "list"]);

/** A tag command writes when a write subcommand follows it — unless the
 *  first word after it names a listing (`npm dist-tag ls d` lists "d"). */
function tagWrite(words: readonly string[], at: number, writes: ReadonlySet<string>, reads: ReadonlySet<string>): boolean {
	const after = words.slice(at + 1).filter((w) => !w.startsWith("-"));
	if (after[0] !== undefined && reads.has(after[0])) return false;
	return after.some((w) => writes.has(w));
}

/** npm runs a unique prefix of a command name: `npm pub` is publish,
 *  `npm unp` unpublish, `npm dep` deprecate (npm 10's own resolution).
 *  Read generously, as git's options are — a prefix npm would reject as
 *  ambiguous (`npm de`) costs a question. `un` is npm's alias for
 *  uninstall; dist-tag has no abbreviation, every prefix of it being
 *  ambiguous with dist-tags. */
function npmCommand(first: string | undefined): string | undefined {
	if (first === undefined || first.length < 2 || first === "un") return first;
	return ["publish", "unpublish", "deprecate"].find((w) => w.startsWith(first)) ?? first;
}

function registryWrite(pm: "npm" | "pnpm" | "yarn", args: readonly LooseWord[]): boolean {
	const words = args.map((a) => a.text);
	const first = words.find((w) => !w.startsWith("-"));
	if (first === "run" || first === "run-script") return false;
	if (pm === "yarn") {
		// berry spells the registry commands `yarn npm …`; classic has no
		// unpublish or deprecate, and its publish takes no dry run
		const berry = words.includes("npm");
		if (words.includes("publish") && !(berry && dryRun(words, true))) return true;
		const tag = words.indexOf("tag");
		return tag !== -1 && tagWrite(words, tag, YARN_TAG_WRITES, YARN_TAG_READS);
	}
	const command = pm === "npm" ? npmCommand(first) : first;
	const publishes = words.includes("publish") || words.includes("unpublish") || command === "publish" || command === "unpublish";
	if (publishes && !dryRun(words, false)) return true;
	if (words.includes("deprecate") || command === "deprecate") return true;
	const tag = words.findIndex((w) => w === "dist-tag" || w === "dist-tags");
	return tag !== -1 && tagWrite(words, tag, NPM_TAG_WRITES, NPM_TAG_READS);
}

function crossing(argv: readonly LooseWord[]): boolean {
	const name = basename(argv[0]?.text ?? "");
	if (name === "git") {
		const inv = gitInvocation(argv.slice(1));
		return inv.sub === "push" && destructivePush(inv.rest);
	}
	if (name === "npm" || name === "pnpm" || name === "yarn") return registryWrite(name, argv.slice(1));
	return false;
}

/** Whether a command line crosses the remote boundary — read as the floor
 *  reads one: past wrappers (sudo, env, timeout), into `sh -c` and eval,
 *  along every command of a chain. */
export function isRemoteBoundary(commandLine: string): boolean {
	const seen = new Set<string>();
	const visit = (line: string, depth: number): boolean => {
		const read = parseShellLooseChecked(line);
		return looseCommands(read.nodes).some(({ argv: raw }) => {
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
			return crossing(argv);
		});
	};
	return visit(commandLine, 0);
}

/** The policy-call form: a shell call whose command crosses. A throw is
 *  not this reading's to answer — see the head comment. */
export function isRemoteBoundaryCall(call: PolicyCall): boolean {
	if (call.name !== "shell" || typeof call.input.command !== "string") return false;
	try {
		return isRemoteBoundary(call.input.command);
	} catch {
		return false;
	}
}
