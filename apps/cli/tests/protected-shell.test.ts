/**
 * kiso never serves its own credential store to a model — the shell
 * check, read without a shell (protected-shell.ts). The real CLI, the
 * delegate child and the file tools are proved in
 * protected-credential-store-e2e.test.ts.
 *
 * A TEMP home, never the real one: every `~` and `$HOME` below is expanded
 * against a mkdtemp directory, and nothing here runs a command.
 */

import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { protectedIdentity } from "@vincemakes/kiso-tools-node";
import { NESTED_TOO_DEEP, TOO_LONG, protectedBangReason, protectedShellCheck, protectedShellExtension, protectedShellReason, protectedShellVerdict } from "../src/protected-shell.js";

// the real clock, taken before anything could fake it
const now = performance.now.bind(performance);

let H = "";
let STORE = "";
let PROJ = "";

beforeEach(() => {
	// .native, as the product resolves: it also expands a Windows 8.3 short name
	H = realpathSync.native(mkdtempSync(join(tmpdir(), "kiso-protected-shell-")));
	mkdirSync(join(H, ".kiso"));
	STORE = join(H, ".kiso", "auth.json");
	writeFileSync(STORE, "{}\n", { mode: 0o600 });
	PROJ = join(H, "proj");
	mkdirSync(PROJ);
	// an unrelated file of the same name, in a project
	writeFileSync(join(PROJ, "auth.json"), "{}\n");
	writeFileSync(join(PROJ, "notes.md"), "notes\n");
});

const env = (): { home: string; kisoHome: string } => ({ home: H, kisoHome: join(H, ".kiso") });
const hit = (line: string, root = H): boolean => protectedShellCheck(line, root, protectedIdentity([STORE]), env()).hit;

describe("a line naming the store is denied", () => {
	it.each([
		"cat ~/.kiso/auth.json",
		"cat $HOME/.kiso/auth.json",
		'cat "${HOME}/.kiso/auth.json"',
		"cat $KISO_HOME/auth.json",
		"cat .kiso/auth.json",
		"cat ./.kiso//auth.json",
		"cd ~/.kiso && cat auth.json",
		"cd ~/.kiso; cat auth.json",
		"cd .kiso && cat auth.json",
		'sh -c "cat ~/.kiso/auth.json"',
		"bash -lc 'cat ~/.kiso/auth.json'",
		'eval "cd ~/.kiso"; cat auth.json',
		"cat < ~/.kiso/auth.json",
		"< ~/.kiso/auth.json cat",
		"echo $(< ~/.kiso/auth.json)",
		"cat `echo ~/.kiso/auth.json`",
		"jq . --from-file=~/.kiso/auth.json",
		"dd if=$HOME/.kiso/auth.json",
		"X=~/.kiso/auth.json env",
		"cat ~/.kiso/*",
		"cat ~/.kiso/auth.*",
		"cat ~/.*/auth.json",
		"sudo -u root cat ~/.kiso/auth.json",
		"cat notes.md; (cat ~/.kiso/auth.json)",
		"cat ~/.kiso/auth.json.tmp-4242",
	])("%s", (line) => {
		expect(hit(line)).toBe(true);
	});

	it("from a project too, where `~` is the only way there", () => {
		expect(hit("cat ~/.kiso/auth.json", PROJ)).toBe(true);
		expect(hit("cat ../.kiso/auth.json", PROJ)).toBe(true);
	});

	it("a symlink to its directory, and a `..` through one", () => {
		symlinkSync(join(H, ".kiso"), join(PROJ, "alias"));
		expect(hit("cat alias/auth.json", PROJ)).toBe(true);
		expect(hit("cd alias && cat auth.json", PROJ)).toBe(true);
		mkdirSync(join(H, ".kiso", "deep"));
		symlinkSync(join(H, ".kiso", "deep"), join(PROJ, "deeplink"));
		// the shell's `..` is taken on the real path: deeplink/.. is .kiso
		expect(hit("cat deeplink/../auth.json", PROJ)).toBe(true);
	});

	it("a hard link under another name", () => {
		linkSync(STORE, join(PROJ, "innocent.txt"));
		expect(hit("cat innocent.txt", PROJ)).toBe(true);
	});

	it("a case variant, on a disk that folds case", () => {
		if (!existsSync(join(H, ".KISO", "AUTH.JSON"))) return; // case-sensitive: no variant exists
		expect(hit("cat ~/.KISO/AUTH.JSON")).toBe(true);
	});

	it("a word it cannot resolve that still names the file", () => {
		expect(hit("cat $D/auth.json")).toBe(true);
		expect(hit('cat "$(dirname x)/auth.json"')).toBe(true);
	});

	it("a relative name read after a `cd` it could not follow", () => {
		expect(hit("cd $D && cat auth.json", PROJ)).toBe(true);
		expect(hit("cd - && cat auth.json", PROJ)).toBe(true);
	});

	it("another account's `~name`, which may be this one's", () => {
		expect(hit("cat ~someone/.kiso/auth.json")).toBe(true);
	});

	it("a directory that holds it and its name, in two words", () => {
		expect(hit("find ~/.kiso -name auth.json -exec cat {} +", PROJ)).toBe(true);
		expect(hit("tar -C ~/.kiso -cf - auth.json", PROJ)).toBe(true);
		// from home, `.` holds it
		expect(hit("find . -name auth.json")).toBe(true);
		// from a project, `.` does not
		expect(hit("find . -name auth.json", PROJ)).toBe(false);
	});

	it("a glob from the root, and one with a `..` after it", () => {
		expect(hit(`cat /${H.split("/")[1]}/*/../${H.split("/").slice(2).join("/")}/.kiso/auth.json`)).toBe(true);
		expect(hit(`cat ${H}/.kis?/auth.json`, PROJ)).toBe(true);
		expect(hit("ls /*", PROJ)).toBe(false);
	});

	it("a line nested deeper than the reader follows", () => {
		const v = protectedShellCheck(`echo ${"$(".repeat(80)}x${")".repeat(80)}`, H, protectedIdentity([STORE]), env());
		expect(v).toEqual({ hit: true, why: NESTED_TOO_DEEP, unread: true });
	});

	it("a line needing more disk reads than the budget: unread, denied", () => {
		// five `;` cds grow the candidate directories to the cap; a thousand
		// words from each is past the 8,000-reading budget
		const words = Array.from({ length: 1_000 }, (_, i) => `w${i}`).join(" ");
		const v = protectedShellCheck(`${"cd a; cd b; ".repeat(5)}cat ${words}`, PROJ, protectedIdentity([STORE]), env());
		expect(v).toEqual({ hit: true, why: TOO_LONG, unread: true });
	});
});

describe("an ordinary line is not", () => {
	it.each([
		"cat ./auth.json",
		"cat auth.json",
		"cat *.md",
		"ls ~/.kiso",
		"cat ~/.kiso/config.json",
		"cd .. && ls",
		"npm test",
		"git log --format=%H -n 3",
		"echo hello > out.txt",
	])("%s (in a project)", (line) => {
		expect(hit(line, PROJ)).toBe(false);
	});

	it("with no protected files, nothing is", () => {
		expect(protectedShellCheck("cat ~/.kiso/auth.json", H, protectedIdentity([]), env()).hit).toBe(false);
	});
});

describe("bounded: no line over 100 ms, the 100k-character hostile lines included", () => {
	const to100k = (unit: (i: number) => string): string => {
		let out = "";
		for (let i = 0; out.length < 100_000; i += 1) out += unit(i);
		return out;
	};
	const lines: readonly (readonly [string, string])[] = [
		["distinct words", `cat ${to100k((i) => `w${i} `)}`],
		["one word, repeated", `cat ${to100k(() => "x ")}`],
		["`;`-joined cds", to100k(() => "cd a; ")],
		["cds, then words", `${to100k(() => "cd a; cd b; ").slice(0, 50_000)}; cat ${to100k((i) => `w${i} `).slice(0, 50_000)}`],
		["a `$(` nest", `echo ${"$(".repeat(50_000)}`],
		["an open-paren run", "(".repeat(100_000)],
		["the name, and many directories", `find auth.json ${to100k((i) => `./d${i} `)}`],
		["globs where the store is", `cat ${to100k(() => "~/.kiso/c* ")}`],
		["globs anywhere else", `cat ${to100k((i) => `src${i}/*.ts `)}`],
		["eval over many words", `eval ${to100k((i) => `w${i} `)}`],
		["many sh -c lines", to100k((i) => `sh -c 'cat f${i}'; `)],
	];
	it.each(lines)("%s", (_name, line) => {
		expect(line.length).toBeGreaterThanOrEqual(50_000);
		protectedShellCheck("ls", PROJ, protectedIdentity([STORE]), env()); // warm the one-time resolution
		// the least of three runs: CI runs these files in parallel on two
		// cores, and one sample there measures the neighbours as much as
		// the check (one did: 139 ms against a local 25)
		let ms = Infinity;
		let v = protectedShellCheck("ls", PROJ, protectedIdentity([STORE]), env());
		for (let run = 0; run < 3; run += 1) {
			const t0 = now();
			v = protectedShellCheck(line, PROJ, protectedIdentity([STORE]), env());
			ms = Math.min(ms, now() - t0);
		}
		// the bound is the readings cap; the clock only shows it holds. A
		// Windows runner's file calls cost about twice a Linux one's (116–119
		// ms measured on the read cap alone), so its budget is 250 ms
		expect(ms, `${ms.toFixed(1)} ms`).toBeLessThan(process.platform === "win32" ? 250 : 100);
		// whatever it decided, it never named the store where the line did not
		if (v.hit && !v.unread) expect(v.why.toLowerCase()).toMatch(/auth\.json|kiso/);
	});
});

describe("the stated blind spots — a reading, not a guarantee", () => {
	// pinned so the header's list stays true: each of these passes the
	// check, and each is the sandbox's to close (post-launch)
	it.each([
		// a name assembled at run time
		"f=au; cat ~/.kiso/${f}th.json",
		// a walk over a directory that holds it
		"grep -r key ~",
	])("%s", (line) => {
		expect(hit(line)).toBe(false);
	});
});

describe("the verdict and the chain member", () => {
	it("the model reads a permanent refusal naming what it read; the person reads what to do instead", () => {
		const v = protectedShellVerdict("cat ~/.kiso/auth.json", H, [STORE], env());
		expect(v).toEqual({ refused: true, why: "~/.kiso/auth.json", unread: false });
		if (!v.refused) return;
		expect(protectedShellReason(v)).toContain("kiso never serves its own credential store to a model");
		expect(protectedShellReason(v)).toContain("~/.kiso/auth.json names a protected file");
		expect(protectedShellReason(v)).toContain("do not retry");
		expect(protectedBangReason(v)).toContain("Run it in your own terminal");
		expect(protectedBangReason(v)).toContain("kiso never puts its credential store on a path to a model");
	});

	it("a check that THROWS denies — never an ask for bypass to outvote", () => {
		const ext = protectedShellExtension({
			files: () => [STORE],
			workspaceRoot: () => H,
			env,
			check: () => {
				throw new RangeError("Maximum call stack size exceeded");
			},
		});
		const v = ext.approvals![0]!.decide({ name: "shell", input: { command: "ls" }, callId: "c" } as never, {} as never) as { action: string; reason?: string };
		expect(v.action).toBe("deny");
		expect(v.reason).toContain("could not read this line");
		expect(v.reason).not.toContain("names a protected file");
	});

	it("denies a shell call and abstains on everything else", () => {
		const ext = protectedShellExtension({ files: () => [STORE], workspaceRoot: () => H, env });
		const decide = ext.approvals![0]!.decide;
		const call = (name: string, input: Record<string, unknown>) => ({ name, input, callId: "c" }) as unknown as Parameters<typeof decide>[0];
		expect(decide(call("shell", { command: "cat ~/.kiso/auth.json" }), {} as never)).toMatchObject({ action: "deny" });
		expect(decide(call("shell", { command: "cat notes.md" }), {} as never)).toEqual({ action: "abstain" });
		expect(decide(call("read_file", { path: ".kiso/auth.json" }), {} as never)).toEqual({ action: "abstain" });
	});
});
