/**
 * S1 (2026-08-12): the examples gate — every examples/*.ts runs FOR REAL
 * (kiso-evals faux provider, zero keys) and must reach its asserted
 * terminal. The examples are the SDK's executable documentation; a
 * silently broken example is a broken promise.
 *
 * Each example self-asserts (exit 0 = terminal reached, exit 1 = assertion
 * failed), so the gate is just spawn + exit code. The cwd is a fresh tmp
 * dir so the examples' session stores never pollute the repo; module
 * resolution still walks up from the example file to the repo's
 * node_modules (tsx is a root devDependency).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

const EXAMPLES = ["hello-agent", "streaming", "headless", "approvals", "resume", "server", "web"];

describe.each(EXAMPLES)("examples/%s.ts", (name) => {
	it("runs to its asserted terminal on the faux provider", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-ex-"));
		const res = spawnSync(TSX, [join(ROOT, "examples", `${name}.ts`)], {
			cwd: dir,
			encoding: "utf8",
			timeout: 60_000,
		});
		expect(
			res.status,
			`example ${name} failed — status=${res.status} error=${res.error}\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
		).toBe(0);
	});
});
