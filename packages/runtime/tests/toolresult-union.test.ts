/**
 * round 5(P1-9) — ToolResult is a discriminated union: an isError:false
 * result structurally cannot carry an errorKind, matching the persisted
 * event schema (which rejects that combination). The @ts-expect-error
 * below FAILS TO COMPILE if the union is ever widened back — the type
 * level is pinned. The runtime test proves a JS tool that sneaks the
 * illegal combination past the type system still cannot poison the
 * session.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

const CALL: FauxScript = [
	{ events: [{ type: "tool_call_end", callId: "c1", name: "web_search", input: {} }, { type: "stop", reason: "tool_use" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

describe("ToolResult discriminated union (P1-9)", () => {
	it("an isError:false result with an errorKind is a TYPE ERROR", () => {
		// @ts-expect-error P1-9: errorKind does not exist on a non-error ToolResult
		const bad: import("@vincemakes/kiso-core").ToolResult = { content: "x", isError: false, errorKind: "fatal" };
		void bad;
		// The legal success shape has NO errorKind key.
		const ok: import("@vincemakes/kiso-core").ToolResult = { content: "fine", isError: false };
		expect(ok.isError).toBe(false);
	});

	it("a JS tool that sneaks isError:false + errorKind past the types cannot poison the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-p19-"));
		const agent = createAgent({
			model: "faux",
			store: new SessionStore(dir),
			tools: [
				defineTool({
					name: "web_search",
					description: "S",
					parameters: { type: "object" },
					execute: async () =>
						({
							content: "sneaky",
							isError: false,
							errorKind: "fatal", // illegal — smuggled past the type
						}) as never,
				}),
			],
			adapter: createFauxProvider(CALL),
		});
		const session = await agent.session({ id: "s" });
		for await (const _ev of session.run("go")) {
			// drain
		}
		// The persisted trajectory is loadable and contiguous — the illegal
		// errorKind never reached the disk.
		const records = new SessionStore(dir).load("s");
		expect(records.map((r) => r.event.seq)).toEqual([...records.map((_, i) => i)]);
		const result = records.find((r) => r.event.type === "tool_result")?.event as { errorKind?: string } | undefined;
		expect(result?.errorKind).toBeUndefined();
	});
});
