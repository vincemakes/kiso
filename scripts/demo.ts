/**
 * kiso demo — a real REPL proving the kernel is usable end to end.
 *
 *   npm run demo          → faux provider (no API key, deterministic)
 *   ANTHROPIC_API_KEY=x npm run demo
 *                        → real Anthropic, model from ANTHROPIC_MODEL
 *
 * Every event streams to the console as it happens; the terminal event
 * ends the turn. This is the "installs and runs a complete agent" proof
 * the kernel's usefulness rests on (ADR-0001: everything outside the loop
 * is yours — this is the smallest yours that exists).
 */

import { createInterface } from "node:readline";
import { createFauxProvider } from "@kiso/evals";
import Anthropic from "@anthropic-ai/sdk";
import { createAnthropicAdapter } from "@kiso/provider-anthropic";
import { defineTool, ToolRegistry, EventLog, loop } from "@kiso/core";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const registry = new ToolRegistry();
registry.register(
	defineTool({
		name: "add",
		description: "Add two numbers",
		parameters: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
		concurrencySafe: () => true,
		execute: async ({ a, b }: { a: number; b: number }) => ({
			content: String(a + b),
			isError: false,
		}),
	}),
);

function makeAdapter() {
	const key = process.env.ANTHROPIC_API_KEY;
	if (key) {
		return createAnthropicAdapter(new Anthropic({ apiKey: key }));
	}
	console.log("[faux mode — set ANTHROPIC_API_KEY for a real model]\n");
	return createFauxProvider([
		{
			events: [
				{ type: "text_start" },
				{ type: "text_delta", text: "I'm the faux model. Try asking me to add: " },
				{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } },
			],
		},
		{ events: [{ type: "stop", reason: "end_turn" }] },
		{
			events: [
				{ type: "text_delta", text: "Now I can see the whole conversation. Ask me anything." },
				{ type: "stop", reason: "end_turn" },
			],
		},
	]);
}

/**
 * One EventLog spans the whole session: every turn's prompt and events are
 * appended to the SAME log, so the loop's projection carries real multi-turn
 * context — the model sees what it said and did before (the old demo started
 * a fresh conversation every turn).
 */
const log = new EventLog();
const adapter = makeAdapter();

async function turn(input: string): Promise<void> {
	log.append({ type: "user_input", content: input });
	for await (const ev of loop({
		adapter,
		model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
		registry,
		log,
	})) {
		switch (ev.type) {
			case "text_delta":
				process.stdout.write(ev.text);
				break;
			case "tool_call_end":
				console.log(`\n[tool] ${ev.name}(${JSON.stringify(ev.input)})`);
				break;
			case "tool_result":
				console.log(`[result] ${ev.content}`);
				break;
			case "terminal":
				console.log(`\n[terminal] ${JSON.stringify(ev.outcome)}\n`);
				break;
		}
	}
}

function prompt(): void {
	rl.question("you> ", async (line) => {
		if (line.trim().toLowerCase() === "exit") {
			rl.close();
			return;
		}
		await turn(line);
		prompt();
	});
}

console.log("kiso — framework demo (faux provider). Type 'exit' to quit.\n");
prompt();
