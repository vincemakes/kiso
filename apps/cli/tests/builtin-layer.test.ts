/**
 * R-D 0.1.45 — the built-in layer gate: the three official extensions that
 * ship with the cli (mcp, skills, subagent) register by MODULE IMPORT —
 * never a disk scan (the user layer's loadExtensions stays word-for-word
 * untouched). The cascade, base → top: built-in → user → project.
 *
 * E5 (the composition round): the task extension left the default
 * composition — measured dead weight on 13 consecutive real-provider
 * sessions (E5-F1/F2: rent paid, never called). It stays an official
 * extension, opt-in via the user layer (copy extensions/task/src/
 * kiso-task.mjs into ~/.kiso/extensions/) or the project layer — a user
 * or project extension named "task" is now a PLAIN extension, no shadow.
 *
 *  - a user extension may SHADOW a built-in by name — the user's deliberate
 *    install wins, loudly, and the shadowed built-in leaves the loaded set;
 *  - the project layer may NOT shadow anything below — the same-name
 *    refusal the loader already applies to the user layer.
 *
 * The e2e pins the fresh-install banner: an EMPTY home reads
 * `[3 extensions: built-in: mcp, skills, subagent]` — the adopter's
 * first 60 seconds, zero disk setup.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { builtInLayer } from "../src/builtin.js";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const FIXTURE: readonly KisoExtension[] = [];

describe("builtInLayer — the built-in layer cascade", () => {
	beforeAll(() => {
		const { dirs } = isolatedEnv();
		// The four factories read the env at creation — never the host's
		// ~/.kiso (the P2 isolation discipline).
		vi.stubEnv("KISO_HOME", dirs.home);
		vi.stubEnv("KISO_MCP_CONFIG", join(dirs.home, "mcp.json"));
		vi.stubEnv("KISO_SKILLS_DIR", dirs.skills);
	});
	afterAll(() => vi.unstubAllEnvs());

	it("registers the three default built-ins, in order, none shadowed", async () => {
		const loaded = await builtInLayer(FIXTURE, FIXTURE);
		expect(loaded.map((e) => e.name)).toEqual(["mcp", "skills", "subagent"]);
	});

	it("a user extension shadows a built-in by name — loudly, the built-in not loaded", async () => {
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const loaded = await builtInLayer([{ name: "mcp", tools: [] } as KisoExtension], FIXTURE);
			expect(loaded.map((e) => e.name)).toEqual(["skills", "subagent"]);
			expect(err).toHaveBeenCalledWith('[extensions] user extension "mcp" shadows the built-in — the built-in is not loaded');
		} finally {
			err.mockRestore();
		}
	});

	it("the project layer may not shadow a built-in — refusing to shadow", async () => {
		await expect(builtInLayer(FIXTURE, [{ name: "skills", tools: [] } as KisoExtension])).rejects.toThrow(
			'extension name "skills" exists in both the built-in and the project-level extensions',
		);
	});

	it("E5: a project extension named 'task' is now a PLAIN extension — the opt-in path (no built-in to collide with)", async () => {
		await expect(builtInLayer(FIXTURE, [{ name: "task", tools: [] } as KisoExtension])).resolves.toHaveLength(3);
	});
});

describe("the fresh-install banner (empty home, piped)", () => {
	it("lists the three default built-ins with zero disk setup", () => {
		const { env } = isolatedEnv();
		// Empty input closes stdin → EOF → the clean exit path. The banner
		// is printed before the chat loop consumes anything, so stdout
		// carries it either way.
		const res = runCli(["chat", "banner-probe"], env, { input: "", timeout: 20_000 });
		expect(stripANSI(res.stdout)).toContain("[3 extensions: built-in: mcp, skills, subagent]");
	});
});
