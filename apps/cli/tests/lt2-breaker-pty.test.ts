/**
 * LT-2 — the loop breaker, end to end on a real PTY.
 *
 * A faux model issues the SAME failing shell call turn after turn. Under
 * `--mode bypass` — the tier that allows everything — the first two run and
 * fail; the third identical attempt is DENIED by the breaker with the
 * count in the reason (the chain law: a deny beats every allow, which is
 * why the breaker denies rather than asks), the model receives that denial
 * and, in the faux script, changes course; the session is healthy after.
 *
 * The evidence is the durable log first (the verdict and who decided it),
 * the screen second (the reason is visible where the call was refused).
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

const FAILING = { type: "tool_call_end", callId: "", name: "shell", input: { command: "false" } };
const turnWith = (callId: string) => ({ events: [{ ...FAILING, callId }, { type: "stop", reason: "tool_use" }] });

describe("LT-2 — the loop breaker on a real PTY", () => {
	it("the third identical failing call is denied with the count; the model continues; bypass does not override it", () => {
		const { env, dirs } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([
				turnWith("f1"),
				turnWith("f2"),
				turnWith("f3"), // this one the breaker refuses
				{ events: [{ type: "text_delta", text: "Changing approach: the command keeps failing." }, { type: "stop", reason: "end_turn" }] },
				...spares(2),
			]),
			KISO_MODE: "bypass",
		});
		const workdir = mkdtempSync(join(tmpdir(), "kiso-breaker-"));
		const raw = ptyRun(["--mode", "bypass", "lt2-breaker"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "go\r"],
				["Changing approach", "exit\r"],
			],
			timeout: 60,
		});
		const plain = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
		// the reason reached the screen where the third call was refused
		expect(plain, "the breaker's reason never showed").toContain("failed 2 times in a row");

		const log = readFileSync(join(dirs.home, "sessions", "lt2-breaker.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l) as { event: Record<string, unknown> & { type: string } });
		const decided = log.filter((e) => e.event.type === "permission_decided");
		// two executed (the tier's allow), the third denied by the breaker
		const denied = decided.filter((e) => e.event.decision === "denied");
		expect(denied, "no denial in the log").toHaveLength(1);
		expect(String(denied[0]!.event.decidedBy ?? ""), "the denial does not name the breaker").toContain("breaker");
		expect(String(denied[0]!.event.reason ?? ""), "the denial carries no count").toContain("failed 2 times in a row");
		const executed = log.filter((e) => e.event.type === "tool_execution_started");
		expect(executed, "the first two attempts should have run").toHaveLength(2);
		// the run completed after the denial: the model got the reason and moved on
		const terminal = log.find((e) => e.event.type === "terminal");
		expect((terminal?.event.outcome as { kind: string } | undefined)?.kind).toBe("completed");
	}, 120_000);
});
