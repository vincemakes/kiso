/**
 * MP-1, the rest (0.40.7) — the picker opens where the session is, and a
 * switch that changes who pays says so.
 *
 * Finding MP-1 (2026-09-21): `/model`'s cursor opened on row 0, so one
 * Enter on a panel opened to LOOK switched the account the session spends.
 * The cursor now opens on the current profile (and `/mode`'s on the tier in
 * force). And when a switch moves the bill — another endpoint, or another
 * credential — one line under the switch notice names the new payee and the
 * old one; a switch that keeps the payer says nothing more.
 *
 * REAL kiso chat under a pty. No request is sent: `/model` and `/mode`
 * switch without a turn. Keys ride the wall clock after the panel paints
 * (the R1.5 lesson the picker suites repeat).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const UP = "\x1b[A";

/** Row order a, b, c; the session starts on c — the LAST row. */
function setup(): NodeJS.ProcessEnv {
	const { dirs, env } = isolatedEnv({ DS_KEY: "fake-ds", GB_KEY: "fake-b" });
	writeFileSync(
		join(dirs.home, "config.json"),
		`${JSON.stringify({
			models: {
				a: { kind: "openai-compat", model: "deepseek-flash", apiKeyEnv: "DS_KEY", baseUrl: "https://api.deepseek.com" },
				b: { kind: "openai-compat", model: "model-b", apiKeyEnv: "GB_KEY", baseUrl: "https://gateway-b.example/v1" },
				c: { kind: "openai-compat", model: "model-c", apiKeyEnv: "GC_UNSET", baseUrl: "https://gateway-c.example/v1" },
			},
		})}\n`,
	);
	// c is paid by a key stored for its origin — `stored key`, not its env var
	writeFileSync(join(dirs.home, "auth.json"), JSON.stringify({ version: 1, credentials: { "endpoint:https://gateway-c.example": { type: "api-key", key: "DUMMY_GC", savedAt: 1 } } }), { mode: 0o600 });
	return env as NodeJS.ProcessEnv;
}

describe("MP-1: the picker opens on the session's own row", () => {
	it("/model then Enter confirms the CURRENT profile (the last row), not row 0 — and says nothing about the payer", () => {
		const t = plain(
			ptyRun(["chat", "mp1-a", "--model", "c"], setup(), {
				feeds: [
					["/mode to switch", "/model\r"],
					["takes effect on the next turn", "exit\r"],
				],
				delays: [[2.6, "\r"]],
			}),
		);
		expect(t, "Enter on the opened panel keeps the session on c").toContain("model → c (model-c @gateway-c.example)");
		expect(t, "row 0 is not what one Enter picks any more").not.toContain("model → a (");
		expect(t, "the payer did not change, so no payee line").not.toContain("paid by");
	}, 240_000);

	it("moving to another account: the switch line, then who pays now and who paid before", () => {
		const t = plain(
			ptyRun(["chat", "mp1-b", "--model", "c"], setup(), {
				feeds: [
					["/mode to switch", "/model\r"],
					["from the next turn", "exit\r"],
				],
				delays: [
					[2.6, UP],
					[3.0, UP],
					[3.4, "\r"],
				],
			}),
		);
		expect(t).toContain("model → a (deepseek-flash @api.deepseek.com");
		expect(t).toContain("paid by @api.deepseek.com · DS_KEY from the next turn — was @gateway-c.example · stored key");
		expect(t, "no key value reaches the screen").not.toMatch(/DUMMY_|fake-/);
	}, 240_000);

	it("/mode opens on the tier in force: Enter under --mode plan keeps plan", () => {
		const t = plain(
			ptyRun(["chat", "mp1-c", "--model", "c", "--mode", "plan"], setup(), {
				feeds: [
					["/mode to switch", "/mode\r"],
					["mode → ", "exit\r"],
				],
				delays: [[2.6, "\r"]],
			}),
		);
		expect(t).toContain("mode → plan");
		expect(t).not.toContain("mode → default");
	}, 240_000);
});
