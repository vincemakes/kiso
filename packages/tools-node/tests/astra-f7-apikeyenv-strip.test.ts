import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { shellTool } from "../src/index.js";

/**
 * Astra F7 (P1, the F1 family) — A PROFILE'S apiKeyEnv NAME IS A SECRET NAME.
 *
 * The child-environment strip removed keys ending in `_API_KEY` or
 * `_AUTH_TOKEN` plus an exact list. A profile's `apiKeyEnv` can be ANY name —
 * `REVIEW_PROVIDER_TOKEN` ends in neither — so the key the profile
 * authenticates with survived into every shell command and every MCP stdio
 * child.
 *
 * The strip has to be told which names are secrets, because only the config
 * knows.
 */
const CTX = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
} as never;

describe("F7: a configured apiKeyEnv name never reaches a child", () => {
	const ws = mkdtempSync(`${tmpdir()}/f7-`);

	it("a custom apiKeyEnv name is stripped when it is declared", async () => {
		process.env.REVIEW_PROVIDER_TOKEN = "sk-SECRET-CUSTOM-NAME";
		const tool = shellTool({ workspaceRoot: ws, secretEnvNames: ["REVIEW_PROVIDER_TOKEN"] } as never);
		const r = await tool.execute({ command: "echo \"[$REVIEW_PROVIDER_TOKEN]\"" } as never, CTX);
		const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
		expect(text).not.toContain("sk-SECRET-CUSTOM-NAME");
		expect(text).toContain("[]");
		delete process.env.REVIEW_PROVIDER_TOKEN;
	});

	it("the existing suffix rules still hold", async () => {
		process.env.SOMETHING_API_KEY = "sk-SUFFIX-RULE";
		const tool = shellTool({ workspaceRoot: ws } as never);
		const r = await tool.execute({ command: "echo \"[$SOMETHING_API_KEY]\"" } as never, CTX);
		const text = typeof r.content === "string" ? r.content : JSON.stringify(r.content);
		expect(text).not.toContain("sk-SUFFIX-RULE");
		delete process.env.SOMETHING_API_KEY;
	});
});
