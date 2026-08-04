/**
 * A 区 — kiso as a coding agent.
 *
 * 1. `kiso` with NO subcommand enters chat directly (equivalent to
 *    `kiso chat`).
 * 2. The system prompt is the coding-agent constant; AGENTS.md or
 *    CLAUDE.md (first found, that priority) is injected once at
 *    construction, truncated at 8KB with a note. No file → no injection.
 * 3. The composed prompt is a pure function of the cwd — byte-stable for
 *    the session's lifetime (D 区).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeSystemPrompt, readProjectInstructions } from "../src/index.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

function workdir(): string {
	return mkdtempSync(join(tmpdir(), "kiso-code-"));
}

describe("A: system prompt composition", () => {
	it("no AGENTS.md/CLAUDE.md → no injection (the bare coding-agent prompt)", () => {
		const dir = workdir();
		const prompt = composeSystemPrompt(dir);
		expect(prompt).toContain("coding agent");
		expect(prompt).not.toContain("Project instructions");
	});

	it("AGENTS.md is injected; CLAUDE.md is NOT when AGENTS.md exists", () => {
		const dir = workdir();
		writeFileSync(join(dir, "AGENTS.md"), "# Team rules\nAlways run tests.\n", "utf8");
		writeFileSync(join(dir, "CLAUDE.md"), "# Old rules\n", "utf8");
		const prompt = composeSystemPrompt(dir);
		expect(prompt).toContain("Project instructions (AGENTS.md)");
		expect(prompt).toContain("Always run tests.");
		expect(prompt).not.toContain("CLAUDE.md");
	});

	it("only CLAUDE.md present → it is injected", () => {
		const dir = workdir();
		writeFileSync(join(dir, "CLAUDE.md"), "# House style\nTabs.\n", "utf8");
		expect(composeSystemPrompt(dir)).toContain("Project instructions (CLAUDE.md)");
	});

	it("an oversized AGENTS.md is truncated at 8KB with a note", () => {
		const dir = workdir();
		writeFileSync(join(dir, "AGENTS.md"), "x".repeat(10 * 1024), "utf8");
		const injected = readProjectInstructions(dir);
		expect(injected.length).toBeLessThan(9 * 1024);
		expect(injected).toContain("truncated at 8192");
	});

	it("composeSystemPrompt is deterministic — byte-identical on repeated calls (D 区)", () => {
		const dir = workdir();
		writeFileSync(join(dir, "AGENTS.md"), "# rules\n", "utf8");
		const a = composeSystemPrompt(dir);
		const b = composeSystemPrompt(dir);
		expect(a).toBe(b);
	});
});

describe("A: bare `kiso` enters chat", () => {
	it("no subcommand runs the chat REPL (faux)", () => {
		const home = mkdtempSync(join(tmpdir(), "kiso-cli-"));
		const result = spawnSync("node", [CLI], {
			input: "hello\nexit\n",
			encoding: "utf8",
			env: { ...process.env, KISO_HOME: home },
			timeout: 30_000,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("session ");
		expect(result.stdout).toContain("faux model");
	});
});
