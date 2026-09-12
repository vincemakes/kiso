/**
 * PR-1 §6.1 — the environment block's SHAPE, and its byte-stability within a
 * session.
 *
 * The block tells the model facts it would otherwise spend a tool call
 * discovering, or guess at. Two properties make it safe to put in a prompt
 * that is fixed for a session's lifetime:
 *
 *   1. its SHAPE is fixed — same lines, same order, the date LAST, so the
 *      bytes above the date are identical across sessions on one machine and
 *      a provider's prefix cache is worth something;
 *   2. within a session it is composed ONCE and never recomputed, so the
 *      prompt cannot drift under the model between one request and the next.
 *
 * The facts are parameters here, so this pins the shape without depending on
 * the machine the suite runs on — a gate that asserts `darwin` is a gate that
 * fails on Linux for no reason.
 */
import { describe, expect, it } from "vitest";
import { environmentBlock, environmentFacts, inGitWorkTree } from "../src/environment-block.js";

const FACTS = {
	workspaceRoot: "/w",
	git: true,
	platform: "darwin",
	osType: "Darwin",
	osRelease: "25.6.0",
	date: "2026-09-11",
	timeZone: "Asia/Singapore",
} as const;

describe("PR-1 — the environment block's shape", () => {
	it("is exactly these lines, in this order, with the DATE LAST", () => {
		expect(environmentBlock(FACTS)).toBe(
			[
				"",
				"# Environment",
				"- Workspace root, your working directory: /w",
				"- Inside a git work tree",
				"- Platform: darwin Darwin 25.6.0; shell runs through /bin/sh in the",
				"  workspace root, not your login shell.",
				"- Session started 2026-09-11 (Asia/Singapore); for the current time, run a",
				"  command.",
			].join("\n"),
		);
	});

	it("says so when the workspace is NOT in a git work tree", () => {
		expect(environmentBlock({ ...FACTS, git: false })).toContain("- Not in a git work tree");
		expect(environmentBlock({ ...FACTS, git: false })).not.toContain("Inside a git");
	});

	it("carries NO model line — /model switches mid-session and the base does not", () => {
		expect(environmentBlock(FACTS)).not.toMatch(/model/i);
	});

	it("carries no current time — only the session's start date, and where to get the time", () => {
		expect(environmentBlock(FACTS)).toContain("for the current time, run a");
		expect(environmentBlock(FACTS)).not.toMatch(/\d\d:\d\d/);
	});

	it("the DATE is the last fact, so everything above it is stable across sessions", () => {
		const lines = environmentBlock(FACTS).split("\n");
		const dated = lines.findIndex((l) => l.includes("Session started"));
		expect(dated).toBe(lines.length - 2); // the continuation line follows it
		expect(lines.slice(0, dated).join("\n")).toBe(environmentBlock({ ...FACTS, date: "1999-01-01" }).split("\n").slice(0, dated).join("\n"));
	});
});

describe("PR-1 — the git line asks the FILESYSTEM, and a worktree's .git is a FILE", () => {
	it("finds .git as a file, not only as a directory", () => {
		// The arms of this very round are built in worktrees, where `.git` is a
		// file. A directory-only check would report "Not in a git work tree" for
		// both arms while the control told the truth — a difference between the
		// arms and the control that has nothing to do with the prompt.
		expect(inGitWorkTree("/repo/wt", (p) => p === "/repo/wt/.git")).toBe(true);
	});

	it("walks UP from the workspace root", () => {
		expect(inGitWorkTree("/repo/packages/core", (p) => p === "/repo/.git")).toBe(true);
	});

	it("stops at the filesystem root rather than looping", () => {
		expect(inGitWorkTree("/nowhere/at/all", () => false)).toBe(false);
	});
});

describe("PR-1 — byte-stability within a session", () => {
	it("the same instant and the same machine give the same bytes", () => {
		const now = new Date("2026-09-11T04:20:00Z");
		const deps = { exists: () => true, platform: "linux", osType: "Linux", osRelease: "6.1.0", timeZone: "UTC" };
		expect(environmentBlock(environmentFacts("/w", now, deps))).toBe(environmentBlock(environmentFacts("/w", now, deps)));
	});

	it("the date is the LOCAL calendar date in the session's zone, not the UTC one", () => {
		// 04:20 UTC is already the 11th in Singapore and still the 10th in
		// New York. A block that said "the 11th" to a reader in New York would
		// be telling them a date they have not reached.
		const now = new Date("2026-09-11T04:20:00Z");
		const at = (timeZone: string) => environmentFacts("/w", now, { exists: () => true, timeZone }).date;
		expect(at("Asia/Singapore")).toBe("2026-09-11");
		expect(at("America/New_York")).toBe("2026-09-11");
		const evening = new Date("2026-09-11T01:00:00Z");
		expect(environmentFacts("/w", evening, { exists: () => true, timeZone: "America/New_York" }).date).toBe("2026-09-10");
	});
});
