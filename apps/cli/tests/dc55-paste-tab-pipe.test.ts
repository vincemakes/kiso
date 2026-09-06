/**
 * DC-55 — the pipe. A pasted tab reaches the model unchanged.
 *
 * The pipe has no composer, so the RENDERING half of DC-55 does not
 * exist here — there is nothing to substitute into and nothing to
 * measure. What must hold is the STORAGE half, at the far end of it:
 * the tab the human pasted is in the durable `user_input`, which is what
 * the model is built from.
 *
 * Asserted on the DURABLE EVENT rather than on stdout: the screen is a
 * projection and the log is the record, and it is the record the model's
 * request is built from.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

describe("DC-55 — a pasted tab survives the pipe", () => {
	it("the durable user_input carries U+0009", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-dc55-pipe-"));
		const work = join(dir, "work");
		mkdirSync(work, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(script, JSON.stringify([{ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }]), "utf8");
		// A pipe delivers the bytes as a line; the bracketed-paste markers
		// are a TTY thing and never appear here, which is the point — the
		// tab arrives as an ordinary byte and must not be filtered.
		try {
			execFileSync("node", [CLI, "chat", "dc55pipe"], {
				env: { ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
				input: "indent\there\nexit\n",
				encoding: "utf8",
				cwd: work,
				timeout: 60_000,
			});
		} catch {
			/* the exit path is not the subject */
		}
		const records = new SessionStore(join(env.KISO_HOME as string, "sessions")).load("dc55pipe");
		const inputs = records.map((r) => r.event).filter((e) => e.type === "user_input");
		expect(inputs.length, "no turn was recorded").toBeGreaterThan(0);
		const text = JSON.stringify(inputs.map((e) => (e as { content: unknown }).content));
		expect(text, "the tab did not reach the durable record").toContain("\\t");
		expect(text, "the tab was rendered as its stand-in on the way to the model").not.toContain("→");
	});
});
