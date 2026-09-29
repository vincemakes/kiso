/**
 * Graphite §7.10 — what the opening says loaded. The banner lays these out
 * (graphite-opening in tui-cells); this is where they come from.
 */

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openingFacts, type OpeningInputs } from "../src/opening.js";
import { projectInstructions, readProjectInstructions } from "../src/coding-prompt.js";

const BASE: OpeningInputs = { resumedEvents: 0, rules: null, skills: null, mcp: null, extensions: "", homeWorkspace: false };

describe("§7.10 — the facts", () => {
	it("a new session with nothing loaded: SESSION and RULES only", () => {
		expect(openingFacts(BASE)).toEqual([
			{ label: "SESSION", value: "new", note: "resumable after kill -9" },
			{ label: "RULES", value: "none", note: "an AGENTS.md or CLAUDE.md here is read" },
		]);
	});

	it("a resumed session says how much it carries", () => {
		expect(openingFacts({ ...BASE, resumedEvents: 187 })[0]).toEqual({ label: "SESSION", value: "resumed", note: "187 events" });
		expect(openingFacts({ ...BASE, resumedEvents: 1 })[0]!.note).toBe("1 event");
	});

	it("RULES names the file the prompt reads", () => {
		expect(openingFacts({ ...BASE, rules: "AGENTS.md" })[1]).toEqual({ label: "RULES", value: "AGENTS.md" });
	});

	it("SKILLS: the count, and the ones that cannot load", () => {
		expect(openingFacts({ ...BASE, skills: { count: 3, broken: 0 } })).toContainEqual({ label: "SKILLS", value: "3", note: "/skills lists them" });
		expect(openingFacts({ ...BASE, skills: { count: 3, broken: 2 } })).toContainEqual({ label: "SKILLS", value: "3", note: "2 cannot load · /skills" });
	});

	it("MCP: servers and tools counted from the tools, the status tool not among them", () => {
		const tools = ["mcp__status", "mcp__github__search", "mcp__github__issue", "mcp__fs__read"];
		expect(openingFacts({ ...BASE, mcp: { tools, connecting: false } })).toContainEqual({ label: "MCP", value: "2 servers", note: "3 tools" });
		expect(openingFacts({ ...BASE, mcp: { tools, connecting: true } })).toContainEqual({ label: "MCP", value: "2 servers", note: "3 tools · connecting…" });
		expect(openingFacts({ ...BASE, mcp: { tools: ["mcp__status"], connecting: true } })).toContainEqual({ label: "MCP", value: "connecting…" });
		expect(openingFacts({ ...BASE, mcp: { tools: [], connecting: false } })).toContainEqual({ label: "MCP", value: "none" });
		expect(openingFacts({ ...BASE, mcp: { tools: ["mcp__one__x"], connecting: false } })).toContainEqual({ label: "MCP", value: "1 server", note: "1 tool" });
	});

	it("EXTENSIONS carries the pipe's own extensions line — one text for what loaded, the dontAsk note beside it", () => {
		expect(openingFacts(BASE).some((f) => f.label === "EXTENSIONS")).toBe(false);
		const line = "[5 extensions: built-in: mcp, skills, subagent, ask (off in dontAsk) · project: lint-guard]";
		expect(openingFacts({ ...BASE, extensions: line })).toContainEqual({ label: "EXTENSIONS", value: line });
	});

	it("DC-49: the home directory as workspace is stated, last, with its remedy", () => {
		const facts = openingFacts({ ...BASE, homeWorkspace: true });
		expect(facts.at(-1)).toEqual({ label: "", value: "home directory as workspace — cd into a project to narrow it" });
	});
});

describe("§7.10 — RULES and the prompt read ONE file", () => {
	it("AGENTS.md before CLAUDE.md; none when neither; a protected target is absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-rules-"));
		expect(projectInstructions(dir)).toBeNull();
		expect(readProjectInstructions(dir)).toBe("");
		writeFileSync(join(dir, "CLAUDE.md"), "claude rules");
		expect(projectInstructions(dir)?.name).toBe("CLAUDE.md");
		writeFileSync(join(dir, "AGENTS.md"), "agent rules");
		expect(projectInstructions(dir)?.name).toBe("AGENTS.md");
		expect(readProjectInstructions(dir)).toContain("=== Project instructions (AGENTS.md) ===\nagent rules");
		// a symlink to a protected file is skipped as though absent — by
		// the prompt AND by the fact, because they are the same lookup
		const secret = join(mkdtempSync(join(tmpdir(), "kiso-rules-secret-")), "store.json");
		writeFileSync(secret, "{}");
		const linked = mkdtempSync(join(tmpdir(), "kiso-rules-link-"));
		symlinkSync(secret, join(linked, "AGENTS.md"));
		expect(projectInstructions(linked, [secret])).toBeNull();
		expect(readProjectInstructions(linked, [secret])).toBe("");
	});
});
