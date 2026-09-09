/**
 * PA-1a (E) — the README's config example is parsed by the real loader,
 * so the documented shape cannot drift from the schema. The example is
 * JSONC (line comments); the comments are stripped the way a reader
 * would, then `parseConfig` judges it.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

function readmeExample(): string {
	const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8");
	// The 2026-09-09 redesign renamed the section; anchor on the new
	// heading and FAIL if it is gone, rather than silently falling back to
	// whatever the file's first jsonc fence happens to be.
	const start = readme.indexOf("## Models and effort");
	expect(start).toBeGreaterThanOrEqual(0);
	const open = readme.indexOf("```jsonc", start);
	const close = readme.indexOf("```", open + 8);
	expect(open).toBeGreaterThan(start);
	expect(close).toBeGreaterThan(open);
	return readme
		.slice(open + "```jsonc".length, close)
		.split("\n")
		.map((line) => line.replace(/(^|\s)\/\/.*$/, ""))
		.join("\n");
}

describe("PA-1a — the README config example parses", () => {
	it("the documented profiles, including the Anthropic one with promptCaching, are accepted by parseConfig", () => {
		const cfg = parseConfig(readmeExample(), "README.md");
		expect(cfg.models?.deepseek?.kind).toBe("openai-compat");
		expect(cfg.models?.claude?.kind).toBe("anthropic");
		expect(cfg.models?.claude?.model).toBe("claude-opus-5");
		expect(cfg.models?.claude?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
		expect(cfg.models?.claude?.promptCaching).toBe(false);
	});
});
