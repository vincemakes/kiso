/**
 * E4-1 — the bare-command faux mislabel (finding E4-1, the 0.2.2 patch
 * round).
 *
 * The default (bare-command) case in index.ts passes the INITIAL
 * `faux = true` into chat — the `faux = currentFaux` assignment that
 * the chat and resume cases carry (index.ts:502/518) is missing in the
 * default case (index.ts:566, after the R-I-p2 input/modelFlag patch).
 * ANY provider failure in a bare-command session therefore surfaces as
 * "[faux mode] the scripted model failed: <real error>" — a false
 * accusation of the keyless demo mode (proven live on a dead-baseUrl
 * probe; the 0.2.1 T5 run-4 incident carried exactly this mislabel).
 *
 * Hermetic: a REAL provider (OPENAI_API_KEY set — never faux) pointed
 * at a DEAD baseUrl fails fast (ECONNREFUSED, no network). Red
 * pre-patch: the capture holds the "[faux mode]" label. Green
 * post-patch: the raw provider error surfaces unlabeled.
 *
 * The non-vacuous guard: the DURABLE terminal (the session record) is
 * an error whose message is the real provider failure — the run
 * genuinely hit the provider and failed; the display assertion is
 * about the label, not about whether a failure happened.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

describe("E4-1: the bare-command faux mislabel", () => {
	it(
		"a bare-command real-provider failure is not mislabeled as faux mode",
		() => {
			const env = isolatedEnv({
				// a REAL provider (never faux) pointed at a dead endpoint —
				// the failure is instant and local.
				OPENAI_BASE_URL: "http://127.0.0.1:1",
				OPENAI_API_KEY: "sk-e4-1-test",
				OPENAI_MODEL: "deepseek-v4-flash",
			});
			const workdir = mkdtempSync(join(tmpdir(), "kiso-e41-"));
			const r = runCli(["e4-1-bare"], env.env, {
				input: "say hi\n",
				cwd: workdir,
				timeout: 30_000,
			});
			const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;

			// The failure path RAN (never vacuous): the durable terminal is
			// an error carrying the real provider failure.
			const events = new SessionStore(join(env.dirs.home, "sessions"))
				.load("e4-1-bare")
				.map((r) => r.event);
			const terminal = events.find((e) => e.type === "terminal");
			expect(terminal).toBeDefined();
			if (terminal?.type !== "terminal") {
				throw new Error("the run ended without a terminal event");
			}
			expect(terminal.outcome.kind).toBe("error");
			if (terminal.outcome.kind !== "error") {
				throw new Error("the terminal outcome is not an error");
			}
			expect(terminal.outcome.error.message).toMatch(/request failed|Connection error|fetch failed/i);

			// The display must NOT accuse the keyless demo mode of the real
			// provider's failure. Pre-patch (red): failOnFauxExhaustion wraps
			// the message as "[faux mode] the scripted model failed: <error>".
			expect(out).not.toContain("[faux mode]");
		},
		60_000,
	);
});
