/**
 * 0.47.3 — every tool says `strict: false` on the wire.
 *
 * The owner's gpt-sol sessions on the ChatGPT backend sent EVERY declared
 * property of every tool: `read_file` an offset on all 58 calls, `edit_file`
 * both its forms on 56 of 57 (an empty or `x` placeholder in the unused
 * one, so the form check refused each), `shell` a `readyWhen: ""` that
 * matched the first output and detached a one-shot command. One request
 * per arm on gpt-6.1-sol settled the cause: with the flag absent the shell
 * call carried all four optional fields; with `strict: false` it carried
 * `command` alone. An absent flag is not "off" there.
 *
 * The schema itself is sent as kiso wrote it: `strict: false` must not come
 * with a rewrite that makes optional properties required.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolSpec } from "@vincemakes/kiso-core";
import { createOpenAIResponsesProvider } from "../src/index.js";
import { type Rig, sseReply, startRig } from "./helpers/rig.js";

const DONE = [
	{ type: "response.created", response: { id: "resp_rig" } },
	{ type: "response.completed", response: { id: "resp_rig", status: "completed", output: [], usage: { input_tokens: 3, output_tokens: 1 } } },
];

/** Two tools shaped like kiso's own: one required field, the rest optional. */
const TOOLS: ToolSpec[] = [
	{
		name: "shell",
		description: "run a command",
		inputSchema: {
			type: "object",
			properties: { command: { type: "string" }, timeoutMs: { type: "integer" }, readyWhen: { type: "string" } },
			required: ["command"],
			additionalProperties: false,
		},
	},
	{
		name: "read_file",
		description: "read a file",
		inputSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "integer" } }, required: ["path"], additionalProperties: false },
	},
];

let rig: Rig;
beforeEach(async () => {
	rig = await startRig(sseReply(DONE));
});
afterEach(async () => {
	await rig.close();
});

type WireTool = { type: string; name: string; parameters: unknown; strict?: unknown };

async function toolsOnTheWire(target: "first-party" | "chatgpt"): Promise<WireTool[]> {
	const adapter = createOpenAIResponsesProvider(
		target === "first-party"
			? { apiKey: "sk-rig", baseUrl: rig.baseUrl }
			: { oauth: async () => ({ access: "tok-abc", accountId: "acct-42" }), baseUrl: rig.baseUrl },
	);
	for await (const _ of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }], tools: TOOLS })) void _;
	expect(rig.requests).toHaveLength(1);
	return (JSON.parse(rig.requests[0]!.body) as { tools: WireTool[] }).tools;
}

describe("0.47.3 — the Responses adapter sends strict: false", () => {
	for (const target of ["chatgpt", "first-party"] as const) {
		it(`${target}: every tool carries strict: false, and its schema as kiso wrote it`, async () => {
			const tools = await toolsOnTheWire(target);
			expect(tools.map((t) => t.name)).toEqual(["shell", "read_file"]);
			for (const [i, t] of tools.entries()) {
				expect(t.strict).toBe(false);
				// no strict-mode rewrite rides along: the optional fields stay optional
				expect(t.parameters).toEqual(TOOLS[i]!.inputSchema);
			}
		});
	}

	it("a request with no tools carries no tools key, and so no strict", async () => {
		const adapter = createOpenAIResponsesProvider({ apiKey: "sk-rig", baseUrl: rig.baseUrl });
		for await (const _ of adapter.stream({ model: "gpt-5.5", messages: [{ role: "user", content: "go" }] })) void _;
		expect(rig.requests[0]!.body).not.toContain('"tools"');
		expect(rig.requests[0]!.body).not.toContain('"strict"');
	});
});
