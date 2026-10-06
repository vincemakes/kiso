/**
 * 0.46.2 — the remote boundary (owner-ratified 2026-10-06, rev 2 with the
 * review's amendments).
 *
 * Two families of shell command change state that other people share:
 *
 *  A. a destructive git push — history rewritten or refs removed:
 *     --force / -f, --force-with-lease, --force-if-includes, a refspec
 *     with a leading `+`, --mirror, --delete / -d, a deleting refspec
 *     (`:branch`), --prune. A dry run (-n / --dry-run) is exempt.
 *  B. a direct package publish: npm, pnpm or yarn with the word
 *     `publish` — not as the script `npm run publish` names, not with
 *     --dry-run.
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
			else if (PUSH_REWRITES.has(flag)) crosses = true;
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

function directPublish(args: readonly LooseWord[]): boolean {
	const words = args.map((a) => a.text);
	if (words.includes("--dry-run")) return false;
	const first = words.find((w) => !w.startsWith("-"));
	if (first === "run" || first === "run-script") return false;
	return words.includes("publish");
}

function crossing(argv: readonly LooseWord[]): boolean {
	const name = basename(argv[0]?.text ?? "");
	if (name === "git") {
		const inv = gitInvocation(argv.slice(1));
		return inv.sub === "push" && destructivePush(inv.rest);
	}
	if (name === "npm" || name === "pnpm" || name === "yarn") return directPublish(argv.slice(1));
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
