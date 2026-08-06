/**
 * finding #11 — KISO_HOME is the ONE root: sessions, trust, the extension
 * scan, the mcp config default, and the skills default all derive from
 * it; the dedicated env vars (KISO_EXTENSIONS_DIR / KISO_MCP_CONFIG /
 * KISO_SKILLS_DIR) still override their own path. Here the CLI runs with
 * ONLY KISO_HOME set — the extensions must come from $KISO_HOME/extensions
 * (RED on the old build, which scanned the real ~/.kiso/extensions) and
 * the session store must live under $KISO_HOME/sessions.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

describe("finding #11: KISO_HOME is the ONE root", () => {
	it("with ONLY KISO_HOME set, extensions scan from $KISO_HOME/extensions and sessions land under $KISO_HOME/sessions", () => {
		const { env, dirs } = isolatedEnv();
		delete env.KISO_EXTENSIONS_DIR; // strip the per-path overrides — KISO_HOME alone must work
		delete env.KISO_MCP_CONFIG;
		delete env.KISO_SKILLS_DIR;
		mkdirSync(join(dirs.home, "extensions"), { recursive: true });
		writeFileSync(join(dirs.home, "extensions", "x.mjs"), "export default { name: \"x\", tools: [] };\n", "utf8");
		const res = runCli(["chat", "kh1"], env, { input: "exit\n" });
		expect(res.status, res.stderr).toBe(0);
		expect(res.stdout).toContain("[1 extension: x]"); // scanned from KISO_HOME, not ~
		expect(existsSync(join(dirs.home, "sessions"))).toBe(true); // the store lives under KISO_HOME
	}, 60_000);
});
