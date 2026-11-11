import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { cdTargets, isGhPrCreate } from "../src/shell-facts.js";

// the lines are spelled for the host's shell (a drive on Windows) and compared as the host spells a path
const A = (p: string): string => (process.platform === "win32" ? `C:${p}` : p);
const R = (p: string): string => resolve(A(p));
const cd = (line: string) => cdTargets(line, A("/w"), A("/h"));

describe("cdTargets: the directories a line moves the shell to", () => {
	it("reads a literal cd that is the first command, or reached only through &&", () => {
		expect(cd(`cd ${A("/a/b")}`)).toEqual([R("/a/b")]);
		expect(cd("cd sub && ls")).toEqual([R("/w/sub")]);
		expect(cd(`ls && cd ${A("/x")}`)).toEqual([R("/x")]);
		expect(cd(`cd ${A("/a")} && cd b`)).toEqual([R("/a"), R("/a/b")]);
		expect(cd("cd ~/docs")).toEqual([R("/h/docs")]);
		expect(cd("cd ~")).toEqual([R("/h")]);
	});
	it("reads nothing it cannot be sure of", () => {
		expect(cd("cd /nonexistent; echo hello")).toEqual([]);
		expect(cd("echo hi; cd /x")).toEqual([]);
		expect(cd("false || cd /x")).toEqual([]);
		expect(cd("(cd /x)")).toEqual([]);
		expect(cd("cd /x | cat")).toEqual([]);
		expect(cd("cd /a; ls")).toEqual([]);
		expect(cd("cd /a && ls; echo done")).toEqual([]);
		expect(cd("false && cd /tmp/x && ls || true")).toEqual([]);
		expect(cd("cd $HOME/x")).toEqual([]);
		expect(cd('cd "$DIR"')).toEqual([]);
		expect(cd("cd -P /x")).toEqual([]);
		expect(cd("cd -")).toEqual([]);
		expect(cd("cd")).toEqual([]);
		expect(cd("ls ~/Desktop")).toEqual([]);
		expect(cd(`cd /a && ${"echo $(".repeat(80)}x${")".repeat(80)}`)).toEqual([]);
	});
});

describe("cdTargets in Git Bash's spelling (the Windows host's dialect, read per call)", () => {
	it("reads /c/x and C:/x as drives and joins ~ to the home folder", () => {
		const was = process.platform;
		Object.defineProperty(process, "platform", { value: "win32" });
		try {
			expect(cdTargets("cd /c/work/x && ls", "C:\\w", "C:\\h")).toEqual(["C:\\work\\x"]);
			expect(cdTargets("cd D:/y; ls", "C:\\w", "C:\\h")).toEqual([]);
			expect(cdTargets("cd sub && cd ~/docs", "C:\\w", "C:\\h")).toEqual(["C:\\w\\sub", "C:\\h\\docs"]);
			expect(cdTargets("cd //server/share", "C:\\w", "C:\\h")).toEqual([]);
		} finally {
			Object.defineProperty(process, "platform", { value: was });
		}
	});
});

describe("isGhPrCreate: a parsed command, not a mention", () => {
	it("is true for the command, alone or in a && chain", () => {
		expect(isGhPrCreate("gh pr create --title x")).toBe(true);
		expect(isGhPrCreate("git push && gh pr create --fill")).toBe(true);
		expect(isGhPrCreate("(gh pr create)")).toBe(false);
	});
	it("is false for text that only names it", () => {
		expect(isGhPrCreate('echo "gh pr create"')).toBe(false);
		expect(isGhPrCreate("gh pr view 12")).toBe(false);
		expect(isGhPrCreate("false && gh pr create --fill || echo https://github.com/a/b/pull/123")).toBe(false);
		expect(isGhPrCreate("gh pr create; echo done")).toBe(false);
		expect(isGhPrCreate("gh $SUB pr create")).toBe(false);
		expect(isGhPrCreate("cat https://github.com/o/r/pull/1")).toBe(false);
	});
});
