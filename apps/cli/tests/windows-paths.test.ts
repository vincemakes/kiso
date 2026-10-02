/**
 * Windows P2 — the three shell safety checks read Git Bash's path dialect
 * (kiso-doc plan-windows-p2-design-2026-10-01.md).
 *
 * On Windows a shell command runs through Git Bash (P1): the syntax is the
 * same, but a path word can be `C:\x`, `C:/x`, `/c/x`, a UNC share, a
 * device path, a drive-relative `C:x`, an alternate data stream, an 8.3
 * short name, or a name Win32 rewrites (`.git.` is `.git`). The read-only
 * allow, the credential deny and the catastrophe floor must read each one
 * as Windows does — or, where they cannot, fail closed: never inside the
 * workspace, never auto-allowed, refused under a destructive verb.
 *
 * Lexical layer: runs on every OS. `process.platform` is set to "win32"
 * per case, the Windows environment is stubbed, and `node:fs` answers for
 * a small fake Windows disk (anything not spelled like a Windows path
 * goes to the real disk). The real-filesystem layer (case on a real disk,
 * junctions, `realpath`) runs on the Windows CI. The POSIX dialect is
 * pinned by the existing suites, which run unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The fake Windows disk: canonical spellings; lookups are case-insensitive. */
const disk = vi.hoisted(() => {
	const dirs = [
		"C:\\",
		"D:\\",
		"C:\\work",
		"C:\\work\\proj",
		"C:\\work\\proj\\src",
		"C:\\work\\proj\\src\\old",
		"C:\\work\\proj\\.git",
		"C:\\Users",
		"C:\\Users\\me",
		"C:\\Users\\me\\.ssh",
		"C:\\Users\\me\\.kiso",
		"C:\\Users\\me\\AppData",
		"C:\\Users\\me\\AppData\\Local",
		"C:\\Users\\me\\AppData\\Local\\Temp",
		"C:\\Users\\me\\AppData\\Local\\Temp\\build",
		"C:\\Users\\me\\AppData\\Roaming",
		"C:\\Windows",
		"C:\\Windows\\System32",
		"C:\\Program Files",
		"C:\\Program Files\\Git",
		"C:\\Program Files (x86)",
		"C:\\ProgramData",
		"C:\\Users\\me\\.kiso\\deep",
		"C:\\Users\\me\\AppData\\Local\\Temp\\home2",
		"C:\\Users\\me\\AppData\\Local\\Temp\\home2\\.ssh",
	];
	const files = ["C:\\work\\proj\\src\\a.ts", "C:\\Users\\me\\notes.txt", "C:\\Users\\runneradmin\\ws\\a.ts"];
	dirs.push("C:\\Users\\runneradmin", "C:\\Users\\runneradmin\\ws");
	const key = (p: string): string => p.replace(/\//g, "\\").replace(/(?<=[^:\\])\\+$/, "").toLowerCase();
	const byKey = new Map<string, { path: string; dir: boolean; ino: number }>();
	[...dirs, ...files].forEach((path, i) => byKey.set(key(path), { path, dir: dirs.includes(path), ino: 9000 + i }));
	// an existing directory's 8.3 short spelling resolves to its long name (the
	// Windows runner's temp dir is C:\Users\RUNNER~1\…)
	for (const [short, long] of [["C:\\Users\\RUNNER~1", "C:\\Users\\runneradmin"], ["C:\\Users\\RUNNER~1\\ws", "C:\\Users\\runneradmin\\ws"], ["C:\\Users\\RUNNER~1\\ws\\a.ts", "C:\\Users\\runneradmin\\ws\\a.ts"], ["C:\\Users\\me\\SSH~1", "C:\\Users\\me\\.ssh"], ["C:\\PROGRA~1", "C:\\Program Files"]] as const) byKey.set(key(short), byKey.get(key(long))!);
	// links (a symlink or a junction): the real path is the target's
	for (const [link, target] of [["C:\\work\\proj\\link", "C:\\Users\\me\\.kiso"], ["C:\\work\\proj\\deeplink", "C:\\Users\\me\\.kiso\\deep"]] as const) byKey.set(key(link), byKey.get(key(target))!);
	const windowsy = (p: unknown): p is string => typeof p === "string" && (/^[A-Za-z]:/.test(p) || p.includes("\\"));
	return { byKey, key, windowsy };
});

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${p}'`), { code: "ENOENT" });
	const look = (p: string) => disk.byKey.get(disk.key(p));
	const fakeStat = (e: { dir: boolean; ino: number }) => ({ isDirectory: () => e.dir, isFile: () => !e.dir, isSymbolicLink: () => false, ino: e.ino, dev: 7, nlink: 1, size: 0 });
	const realpath = (p: string): string => {
		const e = look(p);
		if (e === undefined) throw enoent(p);
		return e.path;
	};
	const realpathSync = Object.assign(
		(p: unknown, ...rest: unknown[]) => (disk.windowsy(p) ? realpath(p) : (real.realpathSync as (...a: unknown[]) => string)(p, ...rest)),
		{ native: (p: unknown, ...rest: unknown[]) => (disk.windowsy(p) ? realpath(p) : (real.realpathSync.native as (...a: unknown[]) => string)(p, ...rest)) },
	);
	const stat =
		(orig: (...a: unknown[]) => unknown) =>
		(p: unknown, opts?: { throwIfNoEntry?: boolean }) => {
			if (!disk.windowsy(p)) return orig(p, opts);
			const e = look(p);
			if (e === undefined) {
				if (opts?.throwIfNoEntry === false) return undefined;
				throw enoent(p);
			}
			return fakeStat(e);
		};
	return {
		...real,
		existsSync: (p: unknown) => (disk.windowsy(p) ? look(p) !== undefined : real.existsSync(p as string)),
		realpathSync,
		statSync: stat(real.statSync as (...a: unknown[]) => unknown),
		lstatSync: stat(real.lstatSync as (...a: unknown[]) => unknown),
		readdirSync: (p: unknown, ...rest: unknown[]) => {
			if (!disk.windowsy(p)) return (real.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
			if (look(p)?.dir !== true) throw enoent(p);
			return [];
		},
	};
});

const { resolveShellPath } = await import("../src/shell-words.js");
const { classifyReadOnly } = await import("../src/readonly-shell.js");
const { floorCheck } = await import("../src/floor.js");
const { protectedShellCheck } = await import("../src/protected-shell.js");

const ROOT = "C:\\work\\proj";
const HOME = "C:\\Users\\me";

const realPlatform = process.platform;
beforeEach(() => {
	Object.defineProperty(process, "platform", { value: "win32", configurable: true });
	vi.stubEnv("SystemRoot", "C:\\Windows");
	vi.stubEnv("ProgramFiles", "C:\\Program Files");
	vi.stubEnv("ProgramFiles(x86)", "C:\\Program Files (x86)");
	vi.stubEnv("ProgramData", "C:\\ProgramData");
	vi.stubEnv("TEMP", "C:\\Users\\me\\AppData\\Local\\Temp");
	vi.stubEnv("TMP", "C:\\Users\\me\\AppData\\Local\\Temp");
	vi.stubEnv("APPDATA", "C:\\Users\\me\\AppData\\Roaming");
	vi.stubEnv("LOCALAPPDATA", "C:\\Users\\me\\AppData\\Local");
	vi.stubEnv("USERPROFILE", HOME);
});
afterEach(() => {
	Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
	vi.unstubAllEnvs();
});

describe("resolveShellPath under Git Bash: the forms it reads", () => {
	const at = (word: string, cwd = ROOT) => resolveShellPath(ROOT, cwd, word);
	const A_TS = "C:\\work\\proj\\src\\a.ts";

	it.each([
		["C:\\work\\proj\\src\\a.ts"],
		["C:/work/proj/src/a.ts"],
		["c:/work/proj/src/a.ts"],
		["/c/work/proj/src/a.ts"],
		["/C/work/proj/src/a.ts"],
		["src/a.ts"],
		["src\\a.ts"],
		["./src/../src/a.ts"],
		["C:\\WORK\\PROJ\\SRC\\A.TS"],
	])("%s is the workspace's src\\a.ts", (word) => {
		expect(at(word)).toMatchObject({ canonical: A_TS, inside: true });
	});

	it("a workspace spelled with an EXISTING 8.3 short name reads normally (the runner's RUNNER~1)", () => {
		const r = resolveShellPath("C:\\Users\\RUNNER~1\\ws", "C:\\Users\\RUNNER~1\\ws", "a.ts");
		expect(r).toMatchObject({ canonical: "C:\\Users\\runneradmin\\ws\\a.ts", inside: true });
		expect(r.opaque).toBeUndefined();
		expect(classifyReadOnly("cat a.ts", "C:\\Users\\RUNNER~1\\ws").allow).toBe(true);
	});

	it("an 8.3 short name: an existing one is expanded, a missing one is only a missing name", () => {
		expect(at("C:/PROGRA~1/Git")).toMatchObject({ canonical: "C:\\Program Files\\Git", inside: false });
		expect(at("src\\PROGRA~1\\x")).toMatchObject({ canonical: "C:\\work\\proj\\src\\PROGRA~1\\x", inside: true });
		expect(at("HEAD~1")).toMatchObject({ canonical: "C:\\work\\proj\\HEAD~1", inside: true });
	});

	it("a `..` after a link that the two readings land apart is opaque; one they agree on is read", () => {
		const r = at("link\\..\\notes.txt");
		expect(r.inside).toBe(false);
		expect(r.opaque).toEqual(expect.any(String));
		expect(at("src\\..\\src\\a.ts")).toMatchObject({ canonical: A_TS, inside: true });
	});

	it("a missing file inside keeps its spelling, inside", () => {
		expect(at("src\\new file.txt")).toMatchObject({ canonical: "C:\\work\\proj\\src\\new file.txt", inside: true });
	});

	it("outside the workspace is outside, by its Windows path", () => {
		expect(at("C:/Users/me/notes.txt")).toMatchObject({ canonical: "C:\\Users\\me\\notes.txt", inside: false });
		expect(at("..\\..\\Users\\me\\notes.txt")).toMatchObject({ canonical: "C:\\Users\\me\\notes.txt", inside: false });
		expect(at("/d/x")).toMatchObject({ canonical: "D:\\x", inside: false });
	});

	it.each([
		[".git.", "C:\\work\\proj\\.git"],
		[".git ", "C:\\work\\proj\\.git"],
		["src. \\a.ts", A_TS],
		["src\\gone.txt. .", "C:\\work\\proj\\src\\gone.txt"],
	])("Win32 drops trailing dots and spaces: %s is %s", (word, canonical) => {
		expect(at(word)).toMatchObject({ canonical });
	});

	it.each([
		["//server/share/a.ts", "UNC"],
		["\\\\server\\share\\a.ts", "UNC"],
		["\\\\?\\C:\\work\\proj\\src\\a.ts", "namespaced"],
		["//?/C:/work/proj/src/a.ts", "namespaced"],
		["\\\\.\\PhysicalDrive0", "device path"],
		["//./PhysicalDrive0", "device path"],
		["\\work\\proj\\src\\a.ts", "drive-rooted"],
		["C:src\\a.ts", "drive-relative"],
		["C:", "drive-relative"],
		["/usr/bin/cat", "MSYS mount"],
		["/tmp/x", "MSYS mount"],
		["/", "MSYS mount"],
		["src/a.ts:secret", "data stream"],
		["NUL", "device name"],
		["src\\con.txt", "device name"],
		["src\\COM1", "device name"],
		["src\\lpt9.log", "device name"],
	])("%s is opaque (%s): never inside", (word) => {
		const r = at(word);
		expect(r.inside).toBe(false);
		expect(r.opaque).toEqual(expect.any(String));
	});
});

describe("the read-only allow under Git Bash", () => {
	const allow = (cmd: string): boolean => classifyReadOnly(cmd, ROOT).allow;

	it.each([
		"cat C:/work/proj/src/a.ts",
		"cat /c/work/proj/src/a.ts",
		"cat 'C:\\work\\proj\\src\\a.ts'",
		"cat src/a.ts",
		"cat 'src\\a.ts'",
		"cat 'C:\\WORK\\PROJ\\SRC\\A.TS'",
		"cat src/a.ts 2>/dev/null",
		"head -n 3 'src\\a.ts'",
		"git diff --stat HEAD~1",
		"git log HEAD~3..HEAD --oneline",
	])("%s runs unasked (inside the workspace)", (cmd) => {
		expect(allow(cmd)).toBe(true);
	});

	it.each([
		"cat C:/Users/me/notes.txt",
		"cat //server/share/a.ts",
		"cat '\\\\server\\share\\a.ts'",
		"cat '\\\\?\\C:\\work\\proj\\src\\a.ts'",
		"cat /etc/hosts",
		"cat 'C:src\\a.ts'",
		"cat 'src/a.ts:secret'",
		"cat 'link\\..\\notes.txt'",
		"cat NUL",
		"cat 'src\\.env'",
		"cat 'src\\.env.'",
		"cat 'src\\.ENV '",
		"cmd /c type src\\a.ts",
		"powershell -Command Get-Content src/a.ts",
	])("%s asks", (cmd) => {
		expect(allow(cmd)).toBe(false);
	});
});

describe("the catastrophe floor under Git Bash", () => {
	const refused = (cmd: string): boolean => floorCheck(cmd, ROOT, HOME).refused;

	it.each([
		["rm -rf 'C:\\'", "a drive root"],
		["rm -rf C:/", "a drive root"],
		["rm -rf /c/", "a drive root"],
		["rm -rf 'D:\\'", "another drive's root"],
		["rm -rf 'C:\\Windows'", "SystemRoot"],
		["rm -rf C:/Windows/System32", "inside SystemRoot"],
		["rm -rf 'C:\\Program Files\\Git'", "inside ProgramFiles"],
		["rm -rf 'C:\\Program Files (x86)'", "ProgramFiles(x86)"],
		["rm -rf C:/ProgramData", "ProgramData"],
		["rm -rf C:/Users", "the users root"],
		["rm -rf C:/Users/me", "the home directory"],
		["rm -rf ~", "the home directory"],
		["rm -rf ~/.ssh", "a home subtree"],
		["rm -rf ~/AppData", "AppData"],
		["rm -rf ~/AppData/Roaming", "inside AppData"],
		["rm -rf C:/Users/me/AppData/Local/Temp", "the temp root"],
		["rm -rf C:/work/proj", "the workspace root"],
		["rm -rf C:/work", "above the workspace"],
		["rm -rf .git.", "the workspace's .git, spelled with a trailing dot"],
		["rm -rf 'C:\\work\\proj\\.GIT'", "the workspace's .git, in another case"],
		["rm -rf //server/share/x", "opaque: UNC"],
		["rm -rf '\\\\server\\share\\x'", "opaque: UNC"],
		["rm -rf '\\\\?\\C:\\x'", "opaque: namespaced"],
		["rm -rf 'C:x'", "opaque: drive-relative"],
		["rm -rf 'D:'", "opaque: drive-relative"],
		["rm -rf '\\x'", "opaque: drive-rooted"],
		["rm -rf /tmp/x", "opaque: an MSYS mount"],
		["rm -rf 'src/a.ts:s'", "opaque: a data stream"],
		["rm -rf ~/SSH~1", "~/.ssh by its short name"],
		["rm -rf C:/PROGRA~1/Git", "inside ProgramFiles, by its short name"],
		["rm -rf link/..", "opaque: a `..` after a link"],
	])("%s is refused (%s)", (cmd) => {
		expect(refused(cmd)).toBe(true);
	});

	it.each([
		"rm -rf src/old",
		"rm -rf 'src\\old'",
		"rm -rf C:/work/proj/src/old",
		"rm -rf /c/work/proj/src/old",
		"rm -rf C:/Users/me/AppData/Local/Temp/build",
		"rm 'src\\a.ts'",
		"rm -rf 'src\\PROGRA~1'",
	])("%s runs (inside the workspace, or inside the temp root)", (cmd) => {
		expect(refused(cmd)).toBe(false);
	});
});

describe("the floor when the home directory sits inside the temp root (the CI runner's layout)", () => {
	it("rm -rf ~/.ssh is still refused: only AppData's temp root is exempt, never another subtree", () => {
		const home2 = "C:\\Users\\me\\AppData\\Local\\Temp\\home2";
		expect(floorCheck("rm -rf ~/.ssh", ROOT, home2).refused).toBe(true);
		expect(floorCheck(`rm -rf '${home2}\\.ssh'`, ROOT, home2).refused).toBe(true);
	});
});

describe("the credential deny under Git Bash", () => {
	const STORE = "C:\\Users\\me\\.kiso\\auth.json";
	const hit = (line: string, cwd = ROOT): boolean =>
		protectedShellCheck(line, cwd, { paths: [STORE], inodes: [] }, { home: HOME, kisoHome: "C:\\Users\\me\\.kiso" }).hit;

	it.each([
		"cat 'C:\\Users\\me\\.kiso\\auth.json'",
		"cat C:/Users/me/.kiso/auth.json",
		"cat c:/users/me/.kiso/auth.json",
		"cat /c/Users/me/.kiso/auth.json",
		"cat ~/.kiso/auth.json",
		'cat "$HOME/.kiso/auth.json"',
		'cat "$KISO_HOME/auth.json"',
		"cat 'C:\\USERS\\ME\\.KISO\\AUTH.JSON'",
		"cat 'C:\\Users\\me\\.kiso\\auth.json.'",
		"cat 'C:\\Users\\me\\.kiso\\auth.json '",
		"cat '..\\..\\Users\\me\\.kiso\\auth.json'",
	])("%s names the credential store", (line) => {
		expect(hit(line)).toBe(true);
	});

	it.each(["cat 'C:\\Users\\me\\.kiso\\*'", "cat ~/.kiso/*.json", "cat C:/Users/me/.KISO/AUTH.*", "cat /c/users/me/.kiso/a*"])("%s reaches the credential store by a wildcard", (line) => {
		expect(hit(line)).toBe(true);
	});

	it("through a link to the store's directory, and a `..` after one", () => {
		expect(hit("cat 'link\\auth.json'")).toBe(true);
		expect(hit("cat deeplink/../auth.json")).toBe(true);
	});

	it("from the home directory, a relative spelling with backslashes", () => {
		expect(hit("cat '.kiso\\auth.json'", HOME)).toBe(true);
	});

	it.each(["cat 'C:\\Users\\me\\.kiso\\other.json'", "cat C:/work/proj/src/a.ts", "cat 'src\\a.ts'"])("%s does not", (line) => {
		expect(hit(line)).toBe(false);
	});
});
