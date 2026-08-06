/**
 * C area (kiso code review, fix 2): the CLI wires microcompact ON by default —
 * threshold = half the model window (KISO_CONTEXT_WINDOW override included).
 *
 * A seeded long session (7 chunky read results, ~1,750 estimated tokens) is
 * resumed with a tiny window (600 tokens → 300-token threshold): the run
 * must record the `microcompacted` boundary on disk and still complete.
 * This is the product-level verification of the "50% by default" claim —
 * with a FIXED threshold (no derivation) or no wiring at all, the boundary
 * never lands.
 */

import { execFileSync } from "node:child_process";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** Seed the session JSONL exactly as the store writes it (runId + ts
 *  outside the event, contiguous seq inside). The session is an OPEN run —
 *  the crash shape — so `kiso resume` continues it. */
function seedSession(home: string, id: string): void {
	const dir = join(home, "sessions");
	mkdirSync(dir, { recursive: true });
	let seq = 0;
	const lines: string[] = [];
	const push = (event: Record<string, unknown>): void => {
		lines.push(JSON.stringify({ runId: "r1", ts: seq, event }));
		seq += 1;
	};
	push({ seq, type: "user_input", content: "start" });
	for (let i = 0; i < 7; i++) {
		push({ seq, type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
		push({ seq, type: "tool_result", callId: `r${i}`, content: "line\n".repeat(200), isError: false });
		push({ seq, type: "user_input", content: `t${i}` });
	}
	writeFileSync(join(dir, `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
}

describe("C area cli: microcompact is on by default at half the model window", () => {
	it("a resume over the threshold records the boundary and completes", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-mc-cli-"));
		const { env: isoEnv, dirs } = isolatedEnv();
		const home = dirs.home;
		seedSession(home, "k9");
		// fauxSkip (the durable script position) = 7 completed turns — the
		// script must cover them: 8 end_turn turns, the resume serves the
		// eighth.
		const script = Array.from({ length: 8 }, () => ({ events: [{ type: "stop", reason: "end_turn" }] }));
		const scriptPath = join(dir, "faux.json");
		writeFileSync(scriptPath, JSON.stringify(script), "utf8");

		// Window 600 tokens → threshold 300; the seeded ~1,750 estimated
		// tokens cross it BEFORE the first model turn.
		const out = execFileSync(process.execPath, [CLI, "resume", "k9"], {
			encoding: "utf8",
			timeout: 60_000,
			env: { ...isoEnv, KISO_FAUX_SCRIPT: scriptPath, KISO_CONTEXT_WINDOW: "600" },
		});
		const durable = readFileSync(join(home, "sessions", "k9.jsonl"), "utf8");
		expect(durable).toContain('"type":"microcompacted"');
		expect(durable).toContain('"kind":"completed"');
		expect(out).toContain("▞"); // the recap line ends the resumed run
	}, 90_000);
});
