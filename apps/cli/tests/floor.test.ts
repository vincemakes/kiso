/**
 * 0.40.0 — the catastrophe floor: the corpus.
 *
 * The owner's line, 2026-09-17: bypass stays bypass — `rm -rf /tmp/probe`
 * RUNS — and the floor refuses only unrecoverable targets. Both halves are
 * pinned here: what is refused (and for the stated reason), and what must
 * still run, the owner's own case first.
 *
 * The home directory is a temporary one passed in, so nothing here depends
 * on — or could touch — the machine's own.
 */

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { floorCheck, floorExtension, isDestructive, isDestructiveCall } from "../src/floor.js";
import { guardSavedAllow } from "../src/protected-writes.js";
import { ConfigError, parseConfig } from "../src/config.js";

let home = "";
let root = "";

beforeAll(() => {
	// .native, as the product resolves: it also expands a Windows 8.3 short name
	home = join(realpathSync.native(mkdtempSync(join(tmpdir(), "kiso-floor-"))), "home");
	root = join(home, "proj");
	mkdirSync(join(home, ".ssh"), { recursive: true });
	mkdirSync(join(home, ".config", "app"), { recursive: true });
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(join(root, "build"), { recursive: true });
	mkdirSync(join(root, "node_modules"), { recursive: true });
	// an EMPTY .git is not a repository — git walks past it, and so must the floor
	mkdirSync(join(root, "src", ".git"), { recursive: true });
	writeFileSync(join(home, ".ssh", "id_rsa"), "k");
	writeFileSync(join(root, "src", "a.ts"), "x");
	symlinkSync(home, join(root, "home-link"));
});

const check = (cmd: string) => floorCheck(cmd, root, home);

/** [command, a word the reason must contain — or a pattern, where the
 *  platform decides which of two true reasons comes first: the test's own
 *  workspace lives under the temp directory, which is /var/folders here
 *  and /tmp on Linux] */
const REFUSED: readonly (readonly [string, string | RegExp])[] = [
	["rm -rf /", "/"],
	["rm -rf /*", "a wildcard over /"],
	["rm -rf --no-preserve-root /", "/"],
	["rm -rf ~", "the home directory"],
	["rm -rf ~/", "the home directory"],
	["rm -rf ~/*", "a wildcard over the home directory"],
	["rm -rf ~/.*", "wildcard"],
	["rm -rf .", "the workspace root"],
	["rm -rf ./", "the workspace root"],
	["rm -rf *", "a wildcard over the workspace root"],
	["rm -rf .*", "a wildcard over the workspace root"],
	["rm -rf ..", "the home directory"],
	["rm -rf ../..", "above the workspace"],
	["rm -rf /usr", "a system root (/usr)"],
	["rm -rf /etc", "a system root (/etc)"],
	["rm -rf /tmp", /a temp root|above the workspace/],
	["rm -rf home-link/", "the home directory"],
	// only a variable: empty, it is the root of whatever follows
	["rm -rf $DIR/", "only a variable"],
	['rm -rf "$HOME"', "the home directory"],
	['rm -rf "${X}"/*', "only a variable"],
	["rm -rf ~/$X", "a wildcard over the home directory"],
	// the well-known home subtrees, and anything inside them
	["rm -rf ~/.ssh", "~/.ssh"],
	["rm ~/.ssh/id_rsa", "~/.ssh"],
	["rm -rf ~/.config/app", "~/.config"],
	["rm -rf ~/.kiso", "~/.kiso"],
	// through wrappers and nested command lines
	["sudo rm -rf /", "/"],
	["sudo -u root rm -rf /", "/"],
	["env A=1 rm -rf ~", "the home directory"],
	["command rm -rf ~", "the home directory"],
	["bash -c 'rm -rf ~'", "the home directory"],
	['sh -lc "rm -rf /"', "/"],
	["eval rm -rf ~", "the home directory"],
	["echo $(rm -rf ~)", "the home directory"],
	["echo `rm -rf ~`", "the home directory"],
	["true && (rm -rf ~)", "the home directory"],
	["ls; rm -rf ~ 2>/dev/null", "the home directory"],
	// a cd moves the target
	["cd / && rm -rf *", "a wildcard over /"],
	["cd ~ && rm -rf .ssh", "~/.ssh"],
	["cd .. && rm -rf proj", "the workspace root"],
	// `||` runs only if the cd FAILED — where it was; `;` either way
	["cd build || rm -rf *", "a wildcard over the workspace root"],
	["cd build; rm -rf *", "a wildcard over the workspace root"],
	["cd && rm -rf *", "the home directory"],
	['cd "$X" && rm -rf *', "the home directory"],
	// the other destructive commands
	["find / -delete", "/"],
	// R6: with no selecting primary, find ranges over everything
	["find . -type f -delete", "find with no selecting primary over the workspace root"],
	["find ~ -delete", "the home directory"],
	// ── the lead's review, 2026-09-18 ──
	// B7: the target of a whole-tree git command is the repository root
	["cd src && git reset --hard", "the workspace root"], // src/.git is empty
	["git -C src reset --hard", "the workspace root"],
	["git -C ~/proj reset --hard", "the workspace root"],
	["git checkout -- :/", "the workspace root"],
	["git clean -f ':(top)'", "the workspace root"],
	["git --work-tree=.. reset --hard", "the home directory"],
	["git --work-tree ~ reset --hard", "the home directory"],
	["git --git-dir=.git --work-tree=. clean -fd ~", "the home directory"],
	["/usr/bin/env rm -rf ~", "the home directory"],
	["/usr/bin/sudo rm -rf /", "/"],
	// B8: $HOME and $PWD are known; a wildcard inside or reaching a subtree
	["rm -rf $HOME/.ssh", "~/.ssh"],
	["rm -rf ${HOME}/.ssh", "~/.ssh"],
	['rm -rf "$HOME"/.ssh', "~/.ssh"],
	["rm -rf ~/.ssh/id_*", "inside ~/.ssh"],
	["rm -rf ~/.ssh*", "reaches ~/.ssh"],
	["rm -rf ~/.c*", "reaches ~/.config"],
	["rm -rf $PWD", "the workspace root"],
	["rm -rf ${PWD}/*", "a wildcard over the workspace root"],
	// B9: a wildcard is over a directory only when it is nothing but globs
	["rm -rf */..", "a wildcard over the workspace root"],
	["rm -rf **/*", "a wildcard over the workspace root"],
	// B10: compound syntax, assignments, child shells, cd's own forms
	["if true; then rm -rf ~; fi", "the home directory"],
	['for f in ~/.ssh/*; do rm -f "$f"; done', "only a variable"],
	["{ rm -rf ~; }", "the home directory"],
	["! rm -rf ~", "the home directory"],
	['X="$Y" rm -rf ~', "the home directory"],
	["sh -c 'cd build' && rm -rf *", "a wildcard over the workspace root"],
	["(cd build) && rm -rf *", "a wildcard over the workspace root"],
	["echo $(cd build) && rm -rf *", "a wildcard over the workspace root"],
	["cd -- .. && rm -rf *", "a wildcard over the home directory"],
	["cd build && cd - && rm -rf *", "a wildcard over the workspace root"],
	["pushd build && popd && rm -rf *", "a wildcard over the workspace root"],
	["eval sh -c 'rm -rf /'", "/"],
	["timeout 5 rm -rf ~", "the home directory"],
	["timeout -s KILL 5 rm -rf ~", "the home directory"],
	["busybox rm -rf ~", "the home directory"],
	// R5: the same loss as checkout -- .
	["git checkout .", "the workspace root"],
	["git checkout ./", "the workspace root"],
	["git checkout HEAD .", "the workspace root"],
	["git checkout -f", "the workspace root"],
	["git restore .", "the workspace root"],
	["git restore --staged --worktree .", "the workspace root"],
	["git switch -f main", "the workspace root"],
	["git switch --discard-changes main", "the workspace root"],
	// the lead's probe, second pass: eval is re-read as the shell would
	["eval 'rm -rf ~'", "the home directory"],
	['eval "rm -rf /"', "/"],
	["eval echo\\;rm -rf /", "/"],
	["eval 'echo $(rm -rf /)'", "/"],
	["eval 'cd .. && rm -rf *'", "a wildcard over the home directory"],
	["cd build && eval 'rm -rf ..'", "the workspace root"],
	["eval rm -rf '$HOME'", "the home directory"],
	["eval eval eval eval eval rm -rf /", "/"],
	["sh -c 'eval \"rm -rf /\"'", "/"],
	// a leading word that is only a variable may be empty
	['eval "$X" rm -rf ~', "the home directory"],
	["$SUDO rm -rf ~", "the home directory"],
	// git -C composes, and outside any repository the directory itself is the target
	["git -C .. reset --hard", "the home directory"],
	["git -C / reset --hard", "/"],
	["git -C ~/.ssh reset --hard", "~/.ssh"],
	["git -C src -C .. reset --hard", "the workspace root"],
	["cd .. && git reset --hard", "the home directory"],
	// a pathspec glob is git's to expand, quoted or not
	["git checkout -- '*'", "a wildcard over the workspace root"],
	["git clean -f build '*'", "a wildcard over the workspace root"],
	// -delete before the selecting primary deletes everything
	["find . -delete -name x", "find with no selecting primary over the workspace root"],
	// the lead's second pass: P3 a partial wildcard is ordinary only inside
	// the workspace, home or temp — not at / or above; P4 the home subtrees
	// come before find's selecting-primary exemption
	["rm -rf /*.log", "a wildcard over /"],
	["rm -rf /**/build", "a wildcard over /"],
	["find ~/.ssh -name x -delete", "~/.ssh"],
	// P1: past the nesting the reader follows, the line is not read — denied
	[`echo ${"$(echo ".repeat(70)}rm -rf ~${")".repeat(70)}`, "nested deeper than the floor reads"],
	["(".repeat(20_000), "nested deeper than the floor reads"],
	// R7: the workspace's history
	["rm -rf .git", "the workspace's .git"],
	["rm -rf .git/objects", "the workspace's .git"],
	// R8: system roots and what is inside them; mount and home roots
	// the root it names is the platform's: on usr-merged Linux /lib IS /usr/lib
	["rm -rf /usr/lib/x", "inside a system root"],
	["rm -rf /opt/x", "inside a system root (/opt)"],
	// R8, second pass: a software prefix itself — not what is inside it
	["rm -rf /usr/local", "a software prefix (/usr/local)"],
	["rm -rf /opt/homebrew", "a software prefix (/opt/homebrew)"],
	["rm -rf /home/linuxbrew/.linuxbrew", "a software prefix"],
	["rm -rf /etc/hosts", "system root"],
	["rm -rf /Users/someoneelse", "a mount or home root"],
	["rm -rf /Volumes/Data", "a mount or home root"],
	["rm -rf /home", "a system root (/home)"],
	["rm -rf /var/folders", /a temp root|above the workspace/],
	["git clean -fdx", "the workspace root"],
	["git clean -f", "the workspace root"],
	["git clean --force -d", "the workspace root"],
	["git -C .. clean -fd", "the home directory"],
	["git reset --hard", "the workspace root"],
	["git reset --hard HEAD~1", "the workspace root"],
	["git checkout -- .", "the workspace root"],
];

const RUNS: readonly string[] = [
	"rm -rf /tmp/probe", // the owner's own case
	"sudo rm -rf /tmp/probe",
	"rm -rf node_modules",
	"rm -rf build/*",
	"rm -rf build",
	"rm src/a.ts",
	"rm -rf foo*",
	"rm -rf $X/build",
	"rm -rf ~/projects/old",
	"find build -name '*.o' -delete",
	"git clean -fd build/",
	"git clean -n",
	"git reset --soft HEAD~1",
	"git reset HEAD src/a.ts",
	"git checkout main",
	// ── the lead's review, 2026-09-18 ──
	// B9: everyday cleanups
	"rm -f *.orig",
	"rm -rf *.log",
	"rm -rf **/node_modules",
	"rm -rf /tmp/*.log",
	"find -L build -delete",
	// R6: a selecting primary ranges over SOME entries
	"find . -name '*.log' -delete",
	"find ~ -name x -delete",
	// B10: a cd inside a subshell stays inside it; the subshell starts where its command runs
	"(cd build && rm -rf *)",
	"cd build && echo $(rm -rf *)",
	"cd build && sh -c 'rm -rf *'",
	// eval's cd persists, and && means it worked
	"eval cd build && rm -rf *",
	// R5: a branch name is never a path
	"git checkout -b feature",
	"git restore --staged .",
	"git restore src/a.ts",
	"git switch main",
	// R8: inside a temp root, and past a mount or home root
	"rm -rf /tmp/build-cache",
	"rm -rf /private/tmp/x",
	"rm -rf /Volumes/Data/proj/node_modules",
	"rm -rf /Users/someoneelse/proj/build",
	// P2: deeper than a mount root runs, by resolved path (macOS /home)
	"rm -rf /home/someone/proj/build",
	// P3: a partial wildcard inside home
	"rm -rf ~/*.log",
	// P5: a dry run deletes nothing
	"git clean -fn",
	"git clean -nf",
	"git clean --dry-run -fd",
	// R8, second pass: inside a reinstallable software prefix
	"rm -rf /usr/local/lib/node_modules/x",
	"rm -rf /opt/homebrew/Cellar/foo",
	"rm -rf /home/linuxbrew/.linuxbrew/Cellar/x",
	"git checkout -- src/a.ts",
	"ls -la / ~ ~/.ssh",
	"cat ~/.ssh/config",
	"echo rm -rf ~",
	"echo 'rm -rf /'",
	"cd build && rm -rf *",
	"cd build && rm -rf * && ls",
	"npm test",
];

/** Windows (P2): a POSIX-rooted path under Git Bash is an MSYS mount — Git's
 *  own tree, never resolved — so it is refused there whatever it names, and
 *  the reason says so instead of naming the POSIX root. */
const WINDOWS = process.platform === "win32";
const MSYS_MOUNT = "an MSYS mount";
const posixRooted = (cmd: string): boolean => /(^|[\s;&|(])\/(?!\/)/.test(cmd);

describe("the floor refuses the unrecoverable, and says which", () => {
	for (const [cmd, why] of REFUSED) {
		it(JSON.stringify(cmd), () => {
			const v = check(cmd);
			expect(v.refused, cmd).toBe(true);
			// (a cd to one leaves every relative path after it unreadable)
			if (WINDOWS && posixRooted(cmd) && v.refused && /an MSYS mount|cannot be read/.test(v.why)) return;
			if (typeof why === "string") expect(v.refused ? v.why : "", cmd).toContain(why);
			else expect(v.refused ? v.why : "", cmd).toMatch(why);
		});
	}
});

describe("and nothing else — bypass stays bypass", () => {
	for (const cmd of RUNS) {
		it(JSON.stringify(cmd), () => {
			// Windows: a POSIX-rooted target is an MSYS mount there — refused
			if (WINDOWS && posixRooted(cmd)) {
				const v = check(cmd);
				expect(v.refused && v.why.includes(MSYS_MOUNT), cmd).toBe(true);
				return;
			}
			expect(check(cmd)).toEqual({ refused: false });
		});
	}
});

describe("destructive, whatever the target — what a saved allow never carries", () => {
	it("names the destructive commands and nothing else", () => {
		for (const cmd of ["rm x", "rm -rf build", "bash -c 'rm x'", "git clean -fd build", "git reset --hard", "git checkout -- a", "find . -delete", "sudo rm x"]) {
			expect(isDestructive(cmd), cmd).toBe(true);
		}
		for (const cmd of ["ls", "git status", "git clean -n", "git reset --soft HEAD~1", "git checkout main", "find . -name x", "echo rm -rf ~", "npm test"]) {
			expect(isDestructive(cmd), cmd).toBe(false);
		}
	});

	it("the saved allow abstains for a destructive shell call, and allows the rest as before", async () => {
		const rules = new Set(["shell"]);
		const saved = {
			name: "dont-ask-again",
			rules,
			approvals: [{ decide: (call: { name: string }) => (rules.has(call.name) ? { action: "allow" as const } : { action: "abstain" as const }) }],
		} as unknown as KisoExtension & { rules: Set<string> };
		const guarded = guardSavedAllow(saved, isDestructiveCall) as KisoExtension & { rules: Set<string> };
		const decide = (command: string) => guarded.approvals![0]!.decide({ name: "shell", input: { command } }, {} as never);
		expect(await decide("rm -rf build")).toEqual({ action: "abstain" });
		expect(await decide("npm test")).toEqual({ action: "allow" });
		// the live handle the grant path mutates is the same object
		expect(guarded.rules).toBe(rules);
		// any other extension passes through untouched
		const other = { name: "safe-test", approvals: [] } as KisoExtension;
		expect(guardSavedAllow(other, isDestructiveCall)).toBe(other);
	});
});

describe("the chain member", () => {
	const decide = (on: boolean, name: string, command: string) =>
		floorExtension(() => on, () => root).approvals![0]!.decide({ name, input: { command } }, {} as never);

	it("denies a catastrophe with the reason the model sees, and abstains otherwise", async () => {
		const v = (await decide(true, "shell", "rm -rf /")) as { action: string; reason?: string };
		expect(v.action).toBe("deny");
		expect(v.reason).toContain("the floor refused this");
		expect(await decide(true, "shell", "rm -rf build")).toEqual({ action: "abstain" });
		expect(await decide(true, "write_file", "rm -rf /")).toEqual({ action: "abstain" });
	});

	it("switched off, it says nothing at all", async () => {
		expect(await decide(false, "shell", "rm -rf /")).toEqual({ action: "abstain" });
	});
});

describe("the switch — the USER's alone", () => {
	it("`floor` is catastrophe or off in the user config", () => {
		expect(parseConfig(JSON.stringify({ floor: "off" }), "~/.kiso/config.json").floor).toBe("off");
		expect(parseConfig(JSON.stringify({ floor: "catastrophe" }), "~/.kiso/config.json").floor).toBe("catastrophe");
		expect(() => parseConfig(JSON.stringify({ floor: "none" }), "~/.kiso/config.json")).toThrow(ConfigError);
	});

	it("a PROJECT config naming it fails loudly — a repository must never lower the floor", () => {
		expect(() => parseConfig(JSON.stringify({ floor: "off" }), "<cwd>/.kiso/config.json")).toThrow(/belongs in the USER config/);
	});
});

describe("B6 — the reader cannot be knocked out, and a knocked-out read denies (the lead's review)", () => {
	const member = (check?: Parameters<typeof floorExtension>[2]) =>
		floorExtension(() => true, () => root, check).approvals![0]!;

	it("a 9 KB `$(` nest is DENIED, in under 10 ms — it used to throw, degrade to ask, and lose to bypass's allow", async () => {
		const command = `rm -rf ${"$(".repeat(4_500)}`;
		expect(command.length).toBeGreaterThan(9_000);
		// warmed once with an ordinary line: the timing is the NEST's cost, not
		// the one-time resolution of the roots (memoized per workspace)
		await member().decide({ name: "shell", input: { command: "ls" } }, {} as never);
		const t0 = performance.now();
		const v = (await member().decide({ name: "shell", input: { command } }, {} as never)) as { action: string };
		const ms = performance.now() - t0;
		expect(v.action).toBe("deny");
		expect(ms, `${ms.toFixed(1)} ms`).toBeLessThan(10);
	});

	it("400 `;`-joined cds are judged in under a second — the candidate set is bounded", () => {
		const cds = Array.from({ length: 200 }, () => "cd src; cd build").join("; ");
		const t0 = performance.now();
		const runs = check(`${cds}; rm -rf node_modules`);
		const refused = check(`${cds}; rm -rf *`);
		const ms = performance.now() - t0;
		expect(ms, `${ms.toFixed(0)} ms`).toBeLessThan(1_000);
		expect(runs.refused).toBe(false);
		// collapsed to {newest, home, workspace root}: a wildcard is still judged against both
		expect(refused.refused).toBe(true);
	});

	it("a read that throws is a DENY, never an ask for bypass to outvote", async () => {
		const v = (await member(() => {
			throw new RangeError("Maximum call stack size exceeded");
		}).decide({ name: "shell", input: { command: "anything" } }, {} as never)) as { action: string; reason?: string };
		expect(v.action).toBe("deny");
		expect(v.reason).toContain("could not read this line");
	});
});
