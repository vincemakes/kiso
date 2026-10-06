/**
 * Graphite §7.10 — what the opening says loaded. The banner lays these out
 * (graphite-opening in tui-cells); this is where they come from.
 */

import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extensionsBannerText, extensionsFact } from "@vincemakes/kiso-tui";
import { openingFacts, type OpeningInputs } from "../src/opening.js";
import { projectInstructions, readProjectInstructions } from "../src/coding-prompt.js";

const BASE: OpeningInputs = { sessionId: "s-1", resumedEvents: 0, faux: false, rules: null, skills: null, mcp: null, extensions: null, homeWorkspace: false };

describe("§7.10 — the facts", () => {
	it("a new session with nothing loaded: SESSION and RULES only", () => {
		expect(openingFacts(BASE)).toEqual([
			{ label: "SESSION", value: "s-1", note: "new · resumable after kill -9" },
			{ label: "RULES", value: "none", note: "an AGENTS.md or CLAUDE.md here is read" },
		]);
	});

	it("a resumed session says how much it carries", () => {
		expect(openingFacts({ ...BASE, resumedEvents: 187 })[0]).toEqual({ label: "SESSION", value: "s-1", note: "resumed · 187 events" });
		expect(openingFacts({ ...BASE, resumedEvents: 1 })[0]!.note).toBe("resumed · 1 event");
	});

	it("the last sweep: SESSION names the id (the `session <id>` line above the opening retired)", () => {
		expect(openingFacts({ ...BASE, sessionId: "2026-10-06T12-20-36-94eb" })[0]!.value).toBe("2026-10-06T12-20-36-94eb");
		// off a dock (no id given) the row keeps its old form — that line still prints there
		expect(openingFacts({ ...BASE, sessionId: null })[0]).toEqual({ label: "SESSION", value: "new", note: "resumable after kill -9" });
		expect(openingFacts({ ...BASE, sessionId: null, extensions: { value: "[4 extensions: built-in: mcp]" } })).toContainEqual({ label: "EXTENSIONS", value: "[4 extensions: built-in: mcp]" });
	});

	it("the last sweep: the faux model says how to leave it, right under SESSION; a real model says nothing here", () => {
		expect(openingFacts({ ...BASE, faux: true })[1]).toEqual({ label: "MODEL", value: "faux", note: "set an API key, or add a model to config.json" });
		expect(openingFacts(BASE).some((f) => f.label === "MODEL")).toBe(false);
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

	it("EXTENSIONS: how many, then the names — built from the SAME lists as the pipe's line, the dontAsk note beside it", () => {
		expect(openingFacts(BASE).some((f) => f.label === "EXTENSIONS")).toBe(false);
		const builtIn = [{ name: "mcp" }, { name: "skills" }, { name: "subagent" }, { name: "ask", note: "off in dontAsk" }];
		const project = [{ name: "lint-guard" }];
		const fact = extensionsFact(builtIn, [{ name: "mine" }], project);
		expect(fact).toEqual({ value: "6", note: "mcp, skills, subagent, ask (off in dontAsk) · user: mine · project: lint-guard" });
		expect(openingFacts({ ...BASE, extensions: fact })).toContainEqual({ label: "EXTENSIONS", value: "6", note: fact!.note });
		// the pipe's line, from the same lists, says the same count and names
		expect(extensionsBannerText(builtIn, [{ name: "mine" }], project)).toBe(" · [6 extensions: built-in: mcp, skills, subagent, ask (off in dontAsk) · mine · project: lint-guard]");
		expect(extensionsFact([], [], [])).toBeNull();
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
