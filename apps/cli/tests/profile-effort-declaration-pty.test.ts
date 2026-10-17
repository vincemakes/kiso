/**
 * 0.51.0 — a profile's declared effort levels reach the `/model` picker.
 *
 * A model no registry knows has no ladder: the row shows no levels. The same
 * model with `"effort"` declared in its profile shows the declared ladder and
 * says whose claim it is, and applying a level goes through the typed
 * command's path (here a level the profile declared; one it did not declare
 * is refused by name). Real `kiso chat` under a pty, faux key, no request.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { ptyRun } from "./helpers/pty.js";

const plain = (t: string): string => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

describe("a declared profile effort reaches the picker", () => {
	it("the declared ladder shows on the opened row with its note, and enter applies the profile at the declared default", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(
			join(dirs.home, "config.json"),
			`${JSON.stringify({
				models: {
					bare: { kind: "openai-compat", model: "no-such-model-in-any-registry", apiKeyEnv: "DECL_KEY", baseUrl: "http://127.0.0.1:9" },
					decl: { kind: "openai-compat", model: "another-unknown-model", apiKeyEnv: "DECL_KEY", baseUrl: "http://127.0.0.1:9", effort: { levels: ["low", "high"], default: "high" } },
				},
			})}\n`,
		);
		const workdir = mkdtempSync(join(tmpdir(), "kiso-decl-w-"));
		const raw = ptyRun(["chat", "decl-a"], { ...env, DECL_KEY: "fake" } as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/mode to switch", "/model\r"],
				["takes effect on the next turn", "exit\r"],
			],
			// ↓ to `decl`, then enter applies the profile at its declared default level
			delays: [
				[2, "\x1b[B"],
				[3.0, "\r"],
			],
		});
		const text = plain(raw);
		expect(text, "the declared ladder").toContain("effort low · high");
		expect(text, "whose claim it is").toContain("levels declared in your profile");
		expect(text, "applied through the typed command's path: the profile and the declared default level").toContain("decl · another-unknown-model @127.0.0.1:9 · high");
	}, 240_000);
});
