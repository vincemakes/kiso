/**
 * HF-1 (0.32.1) — a multi-line shell command does not end the session.
 *
 * The owner's 0.32.0 dogfood, verbatim: the model issued
 * `python3 - <<'EOF' … EOF`, the running card's head row carried the
 * command's newlines, invariant ①b threw inside a repaint timer and the
 * process died — the composer, the run, everything. A heredoc is the most
 * ordinary thing a model writes.
 *
 * On a real PTY: the call runs, the head row shows the command as ONE row
 * with the breaks marked ⏎, the model's next turn arrives, the session
 * exits on `exit`. The durable log carries the execution and a completed
 * terminal. Under the suites' KISO_INVARIANTS=throw, so a leak through any
 * builder is a crash here, never a silent cut.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const HEREDOC = "python3 - <<'EOF'\nimport json\nprint(json.dumps({\"ok\": 1}))\nEOF";

describe("HF-1 — a heredoc shell command on a real PTY", () => {
	it("runs, is shown as one row, and the session survives it", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				{ events: [{ type: "tool_call_end", callId: "h1", name: "shell", input: { command: HEREDOC } }, { type: "stop", reason: "tool_use" }] },
				{ events: [{ type: "text_delta", text: "The heredoc ran fine." }, { type: "stop", reason: "end_turn" }] },
				...spares(2),
			]),
			KISO_MODE: "bypass",
		});
		const workdir = mkdtempSync(join(tmpdir(), "kiso-hf1-"));
		const raw = ptyRun(["--mode", "bypass", "hf1-heredoc"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["The heredoc ran fine.", "exit\r"],
			],
			timeout: 60,
		});
		const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		expect(plain, "the invariant fired — the session died on a heredoc").not.toContain("invariant ①b");
		expect(plain, "the head row shows the command as one row, breaks marked").toContain("python3 - <<'EOF'⏎import json");

		const log = readFileSync(join(dirs.home, "sessions", "hf1-heredoc.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: Record<string, unknown> & { type: string } });
		expect(log.filter((e) => e.event.type === "tool_execution_succeeded"), "the heredoc did not run").toHaveLength(1);
		const terminal = log.find((e) => e.event.type === "terminal");
		expect((terminal?.event.outcome as { kind: string } | undefined)?.kind).toBe("completed");
	}, 120_000);
});
