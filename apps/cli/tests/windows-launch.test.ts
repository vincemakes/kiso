/**
 * Windows P3 — the small spawns.
 *
 * npm is npm.cmd and an editor is often code.cmd: a .cmd/.bat shim needs
 * cmd.exe to start, and Node will not start one without a shell. Both call
 * sites go through `viaCmd` on Windows — cmd.exe `/d /s /c "<line>"`, every
 * word quoted by one function (the cross-spawn rules: CommandLineToArgvW
 * quoting, then a caret before each cmd.exe metacharacter) — never
 * `shell: true`. The shell tool never comes this way (P1: it only starts
 * bash). A sign-in URL opens through rundll32's URL handler (cmd's `start`
 * would cut it at the first `&`). The empty-session trash is kiso's own
 * folder on Windows. The exact cmd.exe behaviour is checked on the real
 * runner (scripts/windows-probe.mjs); these pin the strings, on every OS.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as { file: string; args: readonly string[]; options: Record<string, unknown> }[]);
vi.mock("node:child_process", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:child_process")>();
	return {
		...real,
		spawnSync: (file: string, args: readonly string[], options: Record<string, unknown>) => {
			calls.push({ file, args, options });
			return { status: 0, signal: null, error: undefined, stdout: null, stderr: null, pid: 1, output: [] };
		},
	};
});

const { browserCommand, launchCommand, viaCmd } = await import("../src/launch.js");
const { runExternalEditor } = await import("../src/external-editor.js");
const { defaultTrashRoot } = await import("../src/empty-sessions.js");

const realPlatform = process.platform;
const on = (p: NodeJS.Platform): void => {
	Object.defineProperty(process, "platform", { value: p, configurable: true });
};
afterEach(() => {
	on(realPlatform);
	calls.length = 0;
});

describe("viaCmd: one quoting function for cmd.exe", () => {
	const env = { ComSpec: "C:\\Windows\\system32\\cmd.exe" };
	it("cmd.exe /d /s /c with the whole line quoted once, verbatim", () => {
		expect(viaCmd("npm", ["i", "-g", "@vincemakes/kiso-code@latest"], env)).toEqual({
			file: "C:\\Windows\\system32\\cmd.exe",
			args: ["/d", "/s", "/c", '"npm ^"i^" ^"-g^" ^"@vincemakes/kiso-code@latest^""'],
			windowsVerbatimArguments: true,
		});
	});

	it.each([
		["a b", '^"a^ b^"'],
		["x&y", '^"x^&y^"'],
		["c^d", '^"c^^d^"'],
		["50%PATH%", '^"50^%PATH^%^"'],
		["(z)", '^"^(z^)^"'],
		['say "hi"', '^"say^ \\^"hi\\^"^"'],
		["C:\\dir\\", '^"C:\\dir\\\\^"'],
		["a|b<c>d", '^"a^|b^<c^>d^"'],
	])("the argument %s", (arg, quoted) => {
		expect(viaCmd("x", [arg], env).args[3]).toBe(`"x ${quoted}"`);
	});

	it("without ComSpec, cmd.exe", () => {
		expect(viaCmd("npm", [], {}).file).toBe("cmd.exe");
	});
});

describe("launchCommand: directly, or through cmd.exe on Windows", () => {
	it("POSIX: the program itself (guard)", () => {
		on("linux");
		expect(launchCommand("npm", ["i"])).toEqual({ file: "npm", args: ["i"] });
	});

	it("Windows: through cmd.exe", () => {
		on("win32");
		vi.stubEnv("ComSpec", "C:\\Windows\\system32\\cmd.exe");
		expect(launchCommand("npm", ["i"])).toMatchObject({ file: "C:\\Windows\\system32\\cmd.exe", windowsVerbatimArguments: true });
		vi.unstubAllEnvs();
	});
});

describe("the external editor on Windows starts through cmd.exe", () => {
	it("$VISUAL=code: cmd.exe /d /s /c, the draft's path quoted", () => {
		on("win32");
		const root = mkdtempSync(join(tmpdir(), "kiso-ed-"));
		runExternalEditor("code", root, "draft", () => {});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(calls[0]!.args[3]).toMatch(/^"code \^".*message\.md\^""$/);
		expect(calls[0]!.options).toMatchObject({ stdio: "inherit", windowsVerbatimArguments: true });
	});

	it("POSIX: the editor itself, no shell (guard)", () => {
		on("linux");
		const root = mkdtempSync(join(tmpdir(), "kiso-ed-"));
		runExternalEditor("vim", root, "draft", () => {});
		expect(calls[0]!.file).toBe("vim");
		expect(calls[0]!.options).toMatchObject({ stdio: "inherit", shell: false });
	});
});

describe("browserCommand: the platform's URL opener", () => {
	const url = "https://auth.example/authorize?a=1&b=2&state=x";
	it.each([
		["darwin", ["open", [url]]],
		["linux", ["xdg-open", [url]]],
		["win32", ["rundll32", ["url.dll,FileProtocolHandler", url]]],
	] as const)("%s", (platform, expected) => {
		on(platform);
		expect(browserCommand(url)).toEqual(expected);
	});

	it("elsewhere, none (the URL stays printed)", () => {
		on("aix");
		expect(browserCommand(url)).toBeNull();
	});
});

describe("the empty-session trash", () => {
	it("Windows: kiso's own folder", () => {
		on("win32");
		expect(defaultTrashRoot("C:\\Users\\me\\.kiso")).toBe(join("C:\\Users\\me\\.kiso", "trash"));
	});

	it("macOS: ~/.Trash (guard)", () => {
		on("darwin");
		expect(defaultTrashRoot("/Users/me/.kiso")).toMatch(/\.Trash$/);
	});
});
