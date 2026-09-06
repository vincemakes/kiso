/**
 * E1 — PIPE IDENTITY. The three gestures ship on the dock, and the pipe
 * is unchanged by all of them.
 *
 * A pipe has no editor, so word motion and `ctrl+x` cannot arrive there
 * at all — the interesting half is `/copy`, which is a TYPED command and
 * therefore reaches both surfaces. It must not put an OSC 52 into a
 * consumer's stdout, and it must still answer rather than fail silently.
 *
 * The rule this pins is older than this round (`--plain` is something
 * scripts read), and E1's own clipboard route was written against it:
 * `clipboardWrite` emits NOTHING when stdout is not a TTY.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function pipe(input: string): { stdout: string; status: number } {
	const { env } = isolatedEnv();
	const dir = mkdtempSync(join(tmpdir(), "kiso-e1-pipe-"));
	const work = join(dir, "work");
	mkdirSync(work, { recursive: true });
	const script = join(dir, "faux.json");
	writeFileSync(
		script,
		JSON.stringify([{ events: [{ type: "text_delta", text: "the answer, in **markdown**" }, { type: "stop", reason: "end_turn" }] }]),
		"utf8",
	);
	try {
		const out = execFileSync("node", [CLI, "chat", "e1pipe"], {
			env: { ...env, KISO_FAUX_SCRIPT: script, KISO_MODE: "bypass" },
			input,
			encoding: "utf8",
			cwd: work,
			timeout: 60_000,
		});
		return { stdout: out, status: 0 };
	} catch (e) {
		const err = e as { stdout?: string; status?: number };
		return { stdout: err.stdout ?? "", status: err.status ?? 1 };
	}
}

describe("E1 — the pipe is unchanged", () => {
	it("`/copy` in a pipe emits NO clipboard sequence and says why", () => {
		const r = pipe("go\n/copy\nexit\n");
		expect(r.status).toBe(0);
		// the answer itself still reached the consumer
		expect(r.stdout).toContain("the answer");
		// and NOT one byte of OSC 52 — an escape in a pipe is corruption
		expect(r.stdout).not.toContain("\x1b]52;");
		expect(r.stdout).toContain("no terminal to copy to");
	});

	it("a pipe stays byte-plain — E1 added no ANSI to it", () => {
		const r = pipe("go\n/copy\nexit\n");
		expect(r.stdout).not.toContain("\x1b[");
	});

	it("`/help` names /copy — the command exists on both surfaces", () => {
		const r = pipe("/help\nexit\n");
		expect(r.stdout).toContain("/copy");
	});
});
