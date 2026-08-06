/**
 * Token round — acceptance (2): the big-file default truncation is HONEST and
 * the model CAN continue from its note. The faux script models a model
 * that reads the "… N more lines (call again with offset=…)" note and
 * follows it: first a default read (head 200 + note), then the range read
 * the note names (offset=201 → the tail, no note). The session log proves
 * both the truncated first result and the exact continuation call.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const WORKSPACE = mkdtempSync(join(tmpdir(), "kiso-scope-e2e-"));
const BIG = join(WORKSPACE, "big.txt");
writeFileSync(
	BIG,
	Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
	"utf8",
);

describe("token round e2e: big-file default truncation + continuation reading via the note", () => {
	it("the model reads the head 200 + note, then completes the file with offset=201", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: join(WORKSPACE, "faux.json") });
		// The playbook: default read → the continuation the note names → end.
		const script = [
			{
				events: [
					{ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "big.txt" } },
					{ type: "stop", reason: "tool_use" },
				],
			},
			{
				events: [
					{ type: "tool_call_end", callId: "c2", name: "read_file", input: { path: "big.txt", offset: 201 } },
					{ type: "stop", reason: "tool_use" },
				],
			},
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		writeFileSync(join(WORKSPACE, "faux.json"), JSON.stringify(script), "utf8");

		const out = runCli(["chat", "scope"], env, { input: "read big.txt\nexit\n", cwd: WORKSPACE });
		expect(out.status, out.stderr).toBe(0);

		const durable = readFileSync(join(dirs.home, "sessions", "scope.jsonl"), "utf8");
		const events = durable
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);

		// The default read: head 200 lines + the actionable note.
		const first = events.find((e) => e.type === "tool_result" && e.callId === "c1");
		expect(first.content).toContain("line 200");
		expect(first.content).not.toContain("line 201");
		expect(first.content).toContain("… 50 more lines (call again with offset=201)");

		// The model's continuation follows the note EXACTLY (offset=201).
		const secondCall = events.find((e) => e.type === "tool_call_end" && e.callId === "c2");
		expect(secondCall.input).toEqual({ path: "big.txt", offset: 201 });

		// The tail read completes the file — no note, full content reachable.
		const second = events.find((e) => e.type === "tool_result" && e.callId === "c2");
		expect(second.content).toContain("line 250");
		expect(second.content).not.toContain("more lines");
		expect(second.content).not.toContain("line 199");
	}, 60_000);
});
