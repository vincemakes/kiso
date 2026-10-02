/**
 * 0.40.0 — the read-only shell allow: the corpus.
 *
 * `classifyReadOnly` answers `allow` only for a command line it can prove
 * reads and prints; anything else keeps the approval it had. Three kinds
 * of evidence:
 *  - an ALLOW corpus of the forms a model actually writes;
 *  - an ADVERSARIAL corpus: every construct that would let a "read-only"
 *    first word do something else — chaining, substitution, redirection,
 *    a path out of the workspace or into a credential, a write hiding in
 *    a flag;
 *  - a coverage gate over the table itself: every command on it has at
 *    least one allowed form and one known-bad form below, so a row cannot
 *    be added without saying what it must refuse.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { setMode } from "../src/mode.js";
import { classifyReadOnly, READ_ONLY_COMMANDS, readOnlyShellExtension } from "../src/readonly-shell.js";
import { parseShell, realCase, resolveShellPath } from "../src/shell-words.js";

let root = "";

/** Is this file system case-insensitive (macOS, by default)? The disk-case
 *  cases below only mean something where `.ENV` and `.env` are one file;
 *  on Linux (CI) they are two, and `KHOME/` simply does not exist. */
const CASE_INSENSITIVE = ((): boolean => {
	const d = mkdtempSync(join(tmpdir(), "kiso-case-"));
	writeFileSync(join(d, "probe"), "");
	return existsSync(join(d, "PROBE"));
})();

beforeAll(() => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "kiso-ros-")));
	root = join(base, "ws");
	const outside = join(base, "outside");
	mkdirSync(join(root, "src", "sub"), { recursive: true });
	mkdirSync(outside);
	writeFileSync(join(outside, "secret.txt"), "s");
	writeFileSync(join(root, "README.md"), "# r\n");
	writeFileSync(join(root, "src", "a.ts"), "export {};\n");
	writeFileSync(join(root, "log.txt"), "x\n");
	writeFileSync(join(root, ".env"), "KEY=1\n");
	writeFileSync(join(root, "id_rsa"), "-----\n");
	writeFileSync(join(root, "server.pem"), "-----\n");
	symlinkSync(join(outside, "secret.txt"), join(root, "out-link"));
	symlinkSync(outside, join(root, "out-dir"));
	symlinkSync(join(root, ".env"), join(root, "innocent"));
	// a kiso home INSIDE the workspace — the DC-49 home-workspace shape
	mkdirSync(join(root, "khome"));
	writeFileSync(join(root, "khome", "auth.json"), "{}");
	// B4: the shell's own credential set
	writeFileSync(join(root, ".npmrc"), "//registry/:_authToken=x\n");
	mkdirSync(join(root, ".aws"));
	writeFileSync(join(root, ".aws", "credentials"), "[default]\n");
	mkdirSync(join(root, ".config", "gh"), { recursive: true });
	writeFileSync(join(root, ".config", "gh", "hosts.yml"), "github.com:\n");
});

const verdict = (cmd: string) => classifyReadOnly(cmd, root);

/** [command, the table command it exercises] — each must be allowed. */
const ALLOW: readonly (readonly [string, string])[] = [
	["ls", "ls"],
	["ls -la src", "ls"],
	["ls -1 --color=never src/sub", "ls"],
	["cat README.md", "cat"],
	["cat -n src/a.ts", "cat"],
	["head -n 20 README.md", "head"],
	["head -5 src/a.ts", "head"],
	["tail -n +2 log.txt", "tail"],
	["tail -3 log.txt", "tail"],
	["wc -l src/a.ts README.md", "wc"],
	["pwd", "pwd"],
	["which node", "which"],
	["file README.md", "file"],
	["stat src/a.ts", "stat"],
	["du -sh src", "du"],
	["df -h", "df"],
	["find . -name '*.ts' -type f", "find"],
	["find src -maxdepth 2 -not -path './node_modules/*' -print", "find"],
	["tree -L 2 src", "tree"],
	["grep -n export src/a.ts", "grep"],
	["grep -e export -i src/a.ts README.md", "grep"],
	["rg -n export src/a.ts", "rg"],
	["git status", "git"],
	["git status --short --branch", "git"],
	["git status --porcelain=v1", "git"],
	["git log --oneline -10", "git"],
	["git log --since='2 weeks ago' --author=vince --format=%h", "git"],
	["git log -p -n 3 -- src/a.ts", "git"],
	["git diff", "git"],
	["git diff --stat HEAD~1", "git"],
	["git diff --cached --name-only", "git"],
	["git show HEAD:src/a.ts", "git"],
	["git branch", "git"],
	["git branch -a -v", "git"],
	["git branch --list 'feat/*'", "git"],
	["git branch --merged main", "git"],
	["git --no-pager log -1", "git"],
	["git -C src status", "git"],
	["git rev-parse --abbrev-ref HEAD", "git"],
	["git ls-files src", "git"],
	["node --version", "node"],
	["node -v", "node"],
	["npm --version", "npm"],
	["npm ls --depth=0", "npm"],
	["pnpm --version", "pnpm"],
	["yarn --version", "yarn"],
	["bun --version", "bun"],
	["deno --version", "deno"],
	["python --version", "python"],
	["python3 -V", "python3"],
	["pip --version", "pip"],
	["pip3 --version", "pip3"],
	["cargo --version", "cargo"],
	["rustc --version", "rustc"],
	["go version", "go"],
	["cat README.md | sort", "sort"],
	["sort -r -k 2 log.txt", "sort"],
	["cat log.txt | uniq -c", "uniq"],
	["cut -d: -f1 log.txt", "cut"],
	["cat log.txt | tr a-z A-Z", "tr"],
	// chaining, when every segment is read-only
	["git status && git log --oneline -3", "git"],
	["ls src; cat README.md", "ls"],
	["cat README.md | head -5 | wc -l", "cat"],
	["cd src && ls -la", "ls"],
	// S1: past the first command, rg reads stdin
	["cat log.txt | rg KEY", "rg"],
	["rg --files src", "rg"],
	["rg --version", "rg"],
	// S2: after `cd x &&` the cd provably worked
	["cd src && cd .. && ls", "ls"],
	// S3
	["git log --no-decorate -3", "git"],
	["git log HEAD@{1} -1", "git"],
	["git log @{u}..HEAD --oneline", "git"],
	["du -sP src", "du"],
	["find -d src -name a.ts", "find"],
	["find . -d -name a.ts", "find"], // BSD -d after the path is -depth
	// the redirections that write nothing
	["ls missing 2>/dev/null", "ls"],
	["git log -1 2>&1", "git"],
	["cat README.md >/dev/null", "cat"],
	["wc -l < README.md", "wc"],
	// a tilde in the MIDDLE of a word is a character
	["git log HEAD~3..HEAD --oneline", "git"],
];

/** [command, a word the reason must contain] — each must NOT be allowed. */
const REFUSE: readonly (readonly [string, string])[] = [
	// not on the table, or chained to something that is not
	["rm -rf src", "not on the read-only table"],
	["ls; rm README.md", "rm"],
	["ls && curl https://example.com", "curl"],
	["cat README.md | sh", "sh"],
	["ls || touch x", "touch"],
	["ls\nrm README.md", "rm"],
	["env", "env"],
	["printenv", "printenv"],
	["xargs rm < log.txt", "xargs"],
	["npx tsc --version", "npx"],
	["./ls", "./ls"],
	// the lexer's refusals
	["cat $(echo README.md)", "expansion"],
	["echo $HOME", "expansion"],
	["echo `id`", "expansion"],
	['cat "$FILE"', "expansion"],
	["cat <(curl x)", "subshell"],
	["(ls)", "subshell"],
	["ls &", "background"],
	["FOO=1 ls", "assignment"],
	['FOO="x" ls', "assignment"],
	["wc -l src/*.ts", "glob"],
	["cat .env*", "glob"],
	["cat ~/.ssh/id_rsa", "tilde"],
	["ls --prefix=~/x", "tilde"],
	["ls {a,b}", "brace"],
	["cat <<EOF", "heredoc"],
	["ls # a comment", "comment"],
	["ls |", "empty command"],
	["'unterminated", "unterminated"],
	// redirections that write
	["ls > out.txt", "redirection to out.txt"],
	["ls >> out.txt", "redirection to out.txt"],
	["git log > /tmp/x", "redirection"],
	["ls>out", "glued"],
	["ls &> out", "redirection to out"],
	["cat < .env", "credential"],
	// B1 (the lead's review): `..` is taken on the REAL path — out-dir
	// points outside, so out-dir/.. is outside's parent, not the workspace
	["cat out-dir/../outside/secret.txt", "outside"],
	["ls out-dir/..", "outside"],
	["cd out-dir/.. && ls", "outside"],
	// B2: a case-insensitive disk — .ENV is .env to the file system
	["cat .ENV", "credential"],
	["cat .Env", "credential"],
	["cat ID_RSA", "credential"],
	["cat SERVER.PEM", "credential"],
	["head .ENV", "credential"],
	["grep KEY .ENV", "credential"],
	["cat < .ENV", "credential"],
	["cat src/../.ENV", "credential"],
	// B3: git prints what these name — the CONTENT predicate applies
	["git diff .env", "credential"],
	["git diff -- .env", "credential"],
	["git log -p -- .env", "credential"],
	["git show HEAD:.env", "credential"],
	["git show HEAD -- .env", "credential"],
	["git diff --no-index README.md .env", "credential"],
	["git diff --no-index src build", "--no-index over the directory src"],
	// B4: credentials the search corpus's names do not cover
	["cat .npmrc", "credential"],
	["cat .aws/credentials", "credential"],
	["cat .config/gh/hosts.yml", "credential"],
	["head .docker/config.json", "credential"],
	["cat .kube/config", "credential"],
	["cat .pypirc", "credential"],
	["cat .git-credentials", "credential"],
	["cat .htpasswd", "credential"],
	// paths out of the workspace, or into a credential
	["cat /etc/passwd", "outside"],
	["cat ../outside/secret.txt", "outside"],
	["cat out-link", "outside"],
	["ls out-dir", "outside"],
	["cd .. && ls", "outside"],
	["cd src && cat ../../outside/secret.txt", "outside"],
	["cat .env", "credential"],
	["head id_rsa", "credential"],
	["tail server.pem", "credential"],
	["cat innocent", "leads to a credential"],
	["grep KEY .env", "credential"],
	["find / -name x", "outside"],
	["find . -newer ../outside/secret.txt", "outside"],
	["tree ../outside", "outside"],
	["git -C .. status", "outside"],
	["git diff --no-index /etc/passwd README.md", "outside"],
	// writes and executions hiding in a flag
	["tail -f log.txt", "-f"],
	["tail -F log.txt", "-F"],
	["tail --follow log.txt", "--follow"],
	["find . -delete", "-delete"],
	["find . -exec rm {} ;", "brace"],
	["find . -exec rm x ;", "-exec"],
	["find . -execdir ls ;", "-execdir"],
	["find . -ok rm ;", "-ok"],
	["find . -fprint out", "-fprint"],
	["find . -fls out", "-fls"],
	["find -L .", "-L"],
	["tree -o out.txt", "-o"],
	["tree -R -H . src", "-R"],
	["sort -o out.txt log.txt", "-o"],
	["sort --output=out.txt log.txt", "--output"],
	["sort --compress-program=sh log.txt", "--compress-program"],
	["uniq log.txt out.txt", "output file"],
	["grep -r KEY .", "-r"],
	["grep -R KEY src", "-R"],
	["grep --recursive KEY src", "--recursive"],
	["grep -f patterns.txt src/a.ts", "-f"],
	["rg KEY", "whole tree"],
	["rg KEY src", "directory"],
	["rg --pre sh KEY src/a.ts", "--pre"],
	["rg --pre-glob '*' KEY src/a.ts", "--pre-glob"],
	["rg -z KEY src/a.ts", "-z"],
	["rg --hostname-bin x KEY src/a.ts", "--hostname-bin"],
	["rg --hidden KEY src/a.ts", "--hidden"],
	["rg -uu KEY src/a.ts", "-u"],
	["rg -L KEY src/a.ts", "-L"],
	["wc --files0-from=list", "--files0-from"],
	["ls -la --hyperlink=always src && cat .env", "credential"],
	// git
	["git -c core.fsmonitor=x status", "the git option -c"],
	["git --git-dir=/tmp/x status", "--git-dir"],
	["git --work-tree=.. status", "--work-tree"],
	["git log --output=out.txt", "--output"],
	["git diff --output=out.txt", "--output"],
	["git diff --ext-diff", "--ext-diff"],
	["git log --show-signature", "--show-signature"],
	["git log -L 1,2:src/a.ts", "-L"],
	["git branch newname", "creates a branch"],
	["git branch -d main", "-d"],
	["git branch -D main", "-D"],
	["git branch -m a b", "-m"],
	["git branch -f main HEAD", "-f"],
	["git branch --set-upstream-to=origin/main", "--set-upstream-to"],
	["git branch -u origin/main", "-u"],
	["git checkout main", "git checkout"],
	["git stash", "git stash"],
	["git reset --hard", "git reset"],
	["git push", "git push"],
	["git config --list", "git config"],
	["git remote -v", "git remote"],
	["git status ':(top)x'", "pathspec"],
	["git", "no subcommand"],
	// version queries only
	["node script.js", "version"],
	["node -e 1", "version"],
	["npm install", "version"],
	["npm version patch", "version"],
	["python -c 1", "version"],
	["yarn version", "version"],
	["go run .", "go version"],
	["npm ls --global-style", "--global-style"],
	// cd
	["cd", "cd"],
	["cd -", "cd"],
	["cd src | ls", "cd"],
	["pwd x", "operands"],
];

/** Per table command: at least one form it must refuse (a known-bad row
 *  from the plan where there is one). Keyed by the table's own names. */
const KNOWN_BAD: Readonly<Record<string, string>> = {
	ls: "ls out-dir",
	cat: "cat .env",
	head: "head id_rsa",
	tail: "tail -f log.txt",
	wc: "wc --files0-from=list",
	pwd: "pwd x",
	which: "which -x node",
	file: "file -f list",
	stat: "stat ../outside/secret.txt",
	du: "du -L src",
	df: "df --sync",
	find: "find . -delete",
	tree: "tree -o out.txt",
	grep: "grep -r KEY .",
	rg: "rg --pre sh KEY src/a.ts",
	git: "git branch -D main",
	node: "node script.js",
	npm: "npm install",
	pnpm: "pnpm install",
	yarn: "yarn version",
	bun: "bun run x",
	deno: "deno run x.ts",
	python: "python -c 1",
	python3: "python3 x.py",
	pip: "pip install x",
	pip3: "pip3 install x",
	cargo: "cargo build",
	rustc: "rustc x.rs",
	go: "go run .",
	sort: "sort -o out.txt log.txt",
	uniq: "uniq log.txt out.txt",
	cut: "cut -f1 .env",
	tr: "tr -x a b",
};

describe("the allow corpus — what a model writes, allowed", () => {
	for (const [cmd] of ALLOW) {
		it(JSON.stringify(cmd), () => {
			expect(verdict(cmd)).toEqual({ allow: true });
		});
	}
});

describe("the adversarial corpus — never allowed, and for the stated reason", () => {
	for (const [cmd, why] of REFUSE) {
		it(JSON.stringify(cmd), () => {
			const v = verdict(cmd);
			expect(v.allow, cmd).toBe(false);
			// Windows (P2): a POSIX-rooted path is an MSYS mount under Git Bash —
			// never read, and named so rather than "outside"
			if (process.platform === "win32" && why === "outside" && v.allow === false && v.why.includes("an MSYS mount")) return;
			expect(v.allow === false ? v.why : "", cmd).toContain(why);
		});
	}
});

describe("the table's coverage — no row without an allowed form and a refused one", () => {
	it("every command on the table has an allow case above", () => {
		const covered = new Set(ALLOW.map(([, c]) => c));
		expect(READ_ONLY_COMMANDS.filter((c) => !covered.has(c))).toEqual([]);
	});

	it("every command on the table has a known-bad form, and it is refused", () => {
		expect(READ_ONLY_COMMANDS.filter((c) => KNOWN_BAD[c] === undefined)).toEqual([]);
		for (const c of READ_ONLY_COMMANDS) expect(verdict(KNOWN_BAD[c]!).allow, KNOWN_BAD[c]).toBe(false);
	});

	it("the table has no command the plan rules out", () => {
		for (const never of ["env", "printenv", "set", "export", "jq", "awk", "sed", "xargs", "npx", "sh", "bash", "rm", "curl", "echo"]) {
			expect(READ_ONLY_COMMANDS).not.toContain(never);
		}
	});
});

describe("the lexer — the words the shell would pass, or a refusal", () => {
	it("quotes are removed and join into one word; escapes are characters", () => {
		const p = parseShell(`grep -e 'a b' "c d"e\\ f src/a.ts`);
		expect(p.ok && p.list[0]!.stages[0]!.argv).toEqual(["grep", "-e", "a b", "c de f", "src/a.ts"]);
	});

	it("lists and pipelines keep their structure", () => {
		const p = parseShell("a | b && c; d || e");
		expect(p.ok && p.list.map((x) => [x.joinedBy, x.stages.map((s) => s.argv[0])])).toEqual([
			[null, ["a", "b"]],
			["&&", ["c"]],
			[";", ["d"]],
			["||", ["e"]],
		]);
	});

	it("a trailing `;` is sh's own, a trailing `&&` is not", () => {
		expect(parseShell("ls;").ok).toBe(true);
		expect(parseShell("ls &&").ok).toBe(false);
	});

	it("redirections carry their descriptor", () => {
		const p = parseShell("ls 2>/dev/null >&2 &>/dev/null < in");
		expect(p.ok && p.list[0]!.stages[0]!.redirects).toEqual([
			{ fd: 2, op: ">", target: "/dev/null" },
			{ fd: null, op: ">&", target: "2" },
			{ fd: "&", op: ">", target: "/dev/null" },
			{ fd: null, op: "<", target: "in" },
		]);
	});

	it("a quoted assignment prefix is still an assignment; a quoted command name is not", () => {
		expect(parseShell('FOO="x" rm -rf /').ok).toBe(false);
		expect(parseShell('"FOO=x" rm').ok).toBe(true);
	});
});

describe("the shared resolver — real components, in the disk's case (review B1, B2)", () => {
	it("`..` after a symlink is the parent of its TARGET", () => {
		const r = resolveShellPath(root, root, "out-dir/..");
		expect(r.canonical).toBe(realCase(join(root, "..")));
		expect(r.inside).toBe(false);
	});

	it.skipIf(!CASE_INSENSITIVE)("an existing name comes back in the case the disk holds it", () => {
		expect(resolveShellPath(root, root, ".ENV").canonical).toBe(join(realCase(root), ".env"));
		expect(resolveShellPath(root, root, "SRC/A.TS").canonical).toBe(join(realCase(root), "src", "a.ts"));
	});

	it("past the last existing component the rest is text", () => {
		expect(resolveShellPath(root, root, "nope/deeper/../x").canonical).toBe(join(realCase(root), "nope", "x"));
		expect(resolveShellPath(root, root, "nope/deeper/../x").inside).toBe(true);
	});

	it("a protected root is matched in the disk's case, and LISTING under it asks too (B4)", () => {
		const cmds = ["ls khome", "file khome/auth.json", ...(CASE_INSENSITIVE ? ["cat KHOME/auth.json", "ls -la KHOME"] : [])];
		for (const cmd of cmds) {
			const v = classifyReadOnly(cmd, root, [join(root, "khome")]);
			expect(v.allow, cmd).toBe(false);
			expect(v.allow === false ? v.why : "", cmd).toContain("protected directory");
		}
	});

	it("the chain member protects the home subtrees when the workspace IS home (B4)", async () => {
		// a temporary HOME: no shell runs, nothing of the machine's is read
		const home = realpathSync(mkdtempSync(join(tmpdir(), "kiso-ros-home-")));
		for (const d of [".ssh", ".config", ".aws", ".gnupg", ".kiso"]) mkdirSync(join(home, d));
		writeFileSync(join(home, "notes.md"), "x");
		const saved = process.env.HOME;
		const savedProfile = process.env.USERPROFILE;
		process.env.HOME = home;
		// Windows: the home directory is USERPROFILE (os.homedir reads it)
		process.env.USERPROFILE = home;
		try {
			setMode("default");
			const ext = readOnlyShellExtension(() => ({ workspaceRoot: home, excludeRoots: [join(home, ".kiso")] }));
			const decide = (command: string) => ext.approvals![0]!.decide({ name: "shell", input: { command } }, {} as never);
			for (const cmd of ["ls .ssh", "ls -la .config", "cat .aws/config", "ls .gnupg", "ls .kiso"]) expect(await decide(cmd), cmd).toEqual({ action: "abstain" });
			expect(await decide("cat notes.md")).toEqual({ action: "allow" });
		} finally {
			process.env.HOME = saved;
			if (savedProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = savedProfile;
		}
	});
});
