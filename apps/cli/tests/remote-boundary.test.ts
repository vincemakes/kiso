/**
 * The remote boundary (0.46.2, owner-ratified 2026-10-06): a destructive
 * git push and a registry write change state other people share,
 * and a saved "don't ask again for shell" — permission remembered by TOOL
 * NAME from some earlier call — never carries one. Authority given now
 * still does: full-access runs them, and an explicit user extension that
 * allows them still allows them.
 *
 * Pinned here: which lines cross (both directions, wrappers and git's
 * global options included), and what crossing costs in each tier — one
 * question where a saved rule would have answered, never a refusal the
 * tier did not already make, never a question in full-access.
 */

import { describe, expect, it } from "vitest";
import { composeApprovalChain } from "@vincemakes/kiso-runtime/internal";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { gitInvocation, isDestructiveCall } from "../src/floor.js";
import { isRemoteBoundary, isRemoteBoundaryCall } from "../src/remote-boundary.js";
import { guardSavedAllow, neverInheritedCall } from "../src/protected-writes.js";
import { modeExtensions, setMode, type Mode } from "../src/mode.js";
import { parseShellLoose, looseCommands } from "../src/shell-words.js";

const CROSSES = [
	// A — a destructive remote push: history rewritten, refs deleted
	"git push -f",
	"git push --force origin main",
	"git push --force-with-lease",
	"git push --force-with-lease=main:abc123 origin main",
	"git push --force-if-includes origin main",
	"git push origin +main",
	"git push origin +refs/heads/*:refs/heads/*",
	"git push --mirror",
	"git push --delete origin feature",
	"git push -d origin feature",
	"git push origin :feature",
	"git push origin :refs/tags/v1",
	"git push --prune origin",
	"git push -uf origin main",
	"git push -o ci.skip -f origin main",
	// a dry run turned off again is no dry run: the last setting wins
	"git push --dry-run --no-dry-run --force origin main",
	"git push -n --no-dry-run -f",
	"git push --dry-run --no-dry --force origin main",
	// git takes an unambiguous prefix of a long option
	"git push --mirr",
	"git push --del origin feature",
	"git push --pru origin",
	"git push --force-w origin main",
	"git push --force-i origin main",
	// git's global options before the subcommand, the ones with a value too
	"git --no-pager push --force",
	"git -C repo --no-pager push -f",
	"git -c push.default=current push --force",
	"/usr/bin/git push --force",
	// the floor's reading: wrappers, nested lines, chains
	"sudo git push -f",
	"env GIT_TRACE=1 git push --force",
	'sh -c "git push --force"',
	"cd repo && git push --force-with-lease",
	"git fetch && git push --mirror backup",
	// B — a registry write: a publish
	"npm publish",
	"npm publish --access public",
	"pnpm publish",
	"pnpm -r publish",
	"pnpm --filter pkg publish",
	"npm -w pkg publish",
	"yarn publish",
	"yarn npm publish",
	"yarn workspace foo npm publish",
	// … an unpublish, a deprecation (an empty message lifts one: still a write)
	"npm unpublish pkg@1.0.0",
	"npm unpublish pkg --force",
	"pnpm unpublish pkg@1.0.0",
	'npm deprecate pkg@1 "use 2.x"',
	'npm deprecate pkg@1 ""',
	'pnpm deprecate pkg@"<2" "use 2.x"',
	// … a dist-tag moved, under every name npm takes for add and rm
	"npm dist-tag add pkg@1.2.0 latest",
	"npm dist-tag a pkg@1.2.0 next",
	"npm dist-tag set pkg@1.2.0 next",
	"npm dist-tags s pkg@1.2.0 next",
	"npm dist-tag rm pkg beta",
	"npm dist-tag r pkg beta",
	"npm dist-tag del pkg beta",
	"npm dist-tag d pkg beta",
	"npm dist-tag remove pkg beta",
	"npm dist-tag --registry https://r.example add pkg@1 next",
	"pnpm dist-tag add pkg@1.2.0 latest",
	"yarn tag add pkg@1.2.0 latest",
	"yarn tag rm pkg beta",
	"yarn tag remove pkg beta",
	"yarn npm tag add pkg@1.2.0 beta",
	"yarn npm tag remove pkg beta",
	// a dry run exempts nothing where the command has none, and is off
	// when the parser reads it off
	"npm deprecate pkg@1 msg --dry-run",
	"npm dist-tag add pkg@1 latest --dry-run",
	"yarn publish --dry-run",
	"npm publish --dry-run false",
	"npm publish --dry-run=false",
	"npm publish --dry-run --no-dry-run",
	"npm unpublish pkg --dry-run false",
	// npm runs a unique prefix of a command name
	"npm pub",
	"npm pu --access public",
	"npm unp pkg@1.0.0",
	"npm dep pkg@1 old",
	"npm depr pkg@1 old --dry-run",
];

const STAYS = [
	"git push",
	"git push origin main",
	"git push -u origin main",
	"git push --set-upstream origin feature",
	"git push --tags",
	"git push -o ci.skip origin main",
	"git push origin main:main",
	"git push origin HEAD:refs/heads/review",
	"git push --no-force-with-lease origin main",
	// a dry run changes nothing, wherever its -n sits
	"git push -n --force",
	"git push --dry-run --delete origin feature",
	"git push -nf origin main",
	"git fetch --prune",
	"git pull --force",
	"git branch -D feature",
	"git commit -m 'git push -f'",
	"echo git push --force",
	"npm publish --dry-run",
	"npm publish --dry-run true",
	"npm publish --dry-run=true",
	"pnpm -r publish --dry-run",
	"npm unpublish pkg@1.0.0 --dry-run",
	"yarn npm publish --dry-run",
	"yarn npm publish -n",
	// listing tags and reading the registry change nothing
	"npm dist-tag ls pkg",
	"npm dist-tag ls d",
	"npm dist-tags list",
	"npm dist-tag pkg",
	"npm dist-tag",
	"pnpm dist-tag ls pkg",
	"yarn tag list pkg",
	"yarn tag ls pkg",
	"yarn npm tag list pkg",
	"npm view pkg dist-tags",
	"npm view pkg dist-tags.latest",
	"yarn add tag",
	"npm run deprecate",
	// `un` is npm's alias for uninstall, not a prefix of unpublish
	"npm un pkg",
	"npm pub --dry-run",
	"npm unp pkg@1.0.0 --dry-run",
	// candidates the owner has not named: not in the list
	"npm owner add someone pkg",
	"npm access set status=private pkg",
	"npm run publish",
	"pnpm run publish",
	"yarn run publish",
	"yarn publish:all",
	"npm install publish-tool",
	"npm pack",
	"cat publish.md",
];

describe("the remote boundary: which lines cross it", () => {
	it.each(CROSSES)("crosses: %s", (line) => {
		expect(isRemoteBoundary(line)).toBe(true);
	});

	it.each(STAYS)("does not cross: %s", (line) => {
		expect(isRemoteBoundary(line)).toBe(false);
	});

	it("reads shell calls only, and only a command it was given", () => {
		expect(isRemoteBoundaryCall({ name: "shell", input: { command: "git push --force" } })).toBe(true);
		expect(isRemoteBoundaryCall({ name: "write_file", input: { path: "notes.md", content: "git push --force" } })).toBe(false);
		expect(isRemoteBoundaryCall({ name: "shell", input: {} })).toBe(false);
	});

	it("a line it cannot read is not its question: the destructive reading already answers yes, so a saved allow abstains either way", () => {
		const unreadable = { name: "shell", input: { command: "(".repeat(20_000) } };
		expect(isRemoteBoundaryCall(unreadable)).toBe(false);
		expect(isDestructiveCall(unreadable)).toBe(true);
		expect(neverInheritedCall(unreadable, "/ws")).toBe(true);
	});
});

describe("gitInvocation: git's global options, read to the subcommand (shared with the floor)", () => {
	const argv = (line: string) => looseCommands(parseShellLoose(line))[0]!.argv.slice(1);

	it("skips options without a value, consumes the value of those that take one", () => {
		expect(gitInvocation(argv("git --no-pager -P --no-optional-locks push -f")).sub).toBe("push");
		expect(gitInvocation(argv("git -C a -C b -c x=y --git-dir g --work-tree w --namespace n push")).sub).toBe("push");
		expect(gitInvocation(argv("git --git-dir=g --work-tree=w push --force")).rest.map((w) => w.text)).toEqual(["--force"]);
	});

	it("keeps what the floor reads from them: the -C chain, the work tree, the git dirs", () => {
		const inv = gitInvocation(argv("git -C a -C b --work-tree w --git-dir=g reset --hard"));
		expect(inv.cds.map((w) => w.text)).toEqual(["a", "b"]);
		expect(inv.workTree?.text).toBe("w");
		expect(inv.gitDirs.map((w) => w.text)).toEqual(["g"]);
	});
});

/** The generated rule file's shape: allow by tool name, never deny or ask. */
const savedShellRule: KisoExtension = {
	name: "dont-ask-again",
	approvals: [{ decide: (call) => (call.name === "shell" ? { action: "allow" } : { action: "abstain" }) }],
};

/** The CLI's chain, reduced to what decides a shell call here: the tiers,
 *  then a saved shell rule wrapped exactly as create-coding-agent wraps it. */
async function decide(tier: Mode, command: string, extra: readonly KisoExtension[] = []): Promise<string> {
	setMode(tier);
	const chain = composeApprovalChain([
		...modeExtensions(() => "/ws"),
		guardSavedAllow(savedShellRule, (call) => neverInheritedCall(call, "/ws")),
		...extra.map((e) => guardSavedAllow(e, (call) => neverInheritedCall(call, "/ws"))),
	])!;
	const v = await chain.decide({ name: "shell", input: { command } } as never, {} as never);
	return v.action;
}

describe("what crossing costs, tier by tier, under a saved shell rule", () => {
	it("default and accept-edits: the saved rule still carries a routine push, and no longer a destructive one", async () => {
		try {
			for (const tier of ["default", "accept-edits"] as const) {
				expect(await decide(tier, "git push origin main"), tier).toBe("allow");
				expect(await decide(tier, "touch made.txt"), tier).toBe("allow");
				for (const line of ["git push --force-with-lease", "git push origin :feature", "npm publish", "npm unpublish pkg@1", "npm deprecate pkg@1 old", "npm dist-tag add pkg@1 latest"]) {
					expect(await decide(tier, line), `${tier}: ${line}`).toBe("ask");
				}
			}
		} finally {
			setMode("default");
		}
	});

	it("full-access still runs it — authority given now is not remembered authority", async () => {
		try {
			for (const line of ["git push --force", "git push --mirror", "npm publish", "npm unpublish pkg@1", "npm dist-tag rm pkg beta"]) expect(await decide("full-access", line), line).toBe("allow");
		} finally {
			setMode("default");
		}
	});

	it("plan refuses it as it refuses every shell call — the boundary adds no refusal of its own", async () => {
		try {
			expect(await decide("plan", "git push --force")).toBe("deny");
			expect(await decide("plan", "git push origin main")).toBe("deny");
		} finally {
			setMode("default");
		}
	});

	it("a false positive costs one question, never a refusal, and never a question in full-access", async () => {
		try {
			// `npm view publish` names a package called publish: read as a publish
			expect(isRemoteBoundary("npm view publish")).toBe(true);
			expect(await decide("default", "npm view publish")).toBe("ask");
			expect(await decide("full-access", "npm view publish")).toBe("allow");
			// a word that merely contains publish is not the word
			expect(await decide("default", "npm install publish-tool")).toBe("allow");
			// `npm install deprecate` installs a package called deprecate: read as a deprecation
			expect(await decide("default", "npm install deprecate")).toBe("ask");
		} finally {
			setMode("default");
		}
	});

	it("an explicit user extension that allows a publish still allows it — the wrap is for the saved rule alone", async () => {
		const releaseOk: KisoExtension = {
			name: "release-ok",
			approvals: [{ decide: (call) => (call.name === "shell" && String(call.input.command).startsWith("npm publish") ? { action: "allow" } : { action: "abstain" }) }],
		};
		try {
			expect(await decide("default", "npm publish", [releaseOk])).toBe("allow");
		} finally {
			setMode("default");
		}
	});

	it("the older classes stay: a write into .git/ and a destructive command are not carried either", async () => {
		expect(neverInheritedCall({ name: "write_file", input: { path: ".git/config", content: "x" } }, "/ws")).toBe(true);
		expect(neverInheritedCall({ name: "shell", input: { command: "rm -rf build" } }, "/ws")).toBe(true);
		expect(neverInheritedCall({ name: "shell", input: { command: "git push origin main" } }, "/ws")).toBe(false);
	});
});
