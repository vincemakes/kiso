#!/usr/bin/env node
/**
 * kiso — the coding-agent reference product.
 *
 *   kiso chat [sessionId]   start or continue an interactive session
 *   kiso resume <sessionId> continue a session in one-shot mode
 *   kiso sessions           list durable sessions
 *
 * Provider selection (first match):
 *   ANTHROPIC_API_KEY      → Anthropic (ANTHROPIC_MODEL, default claude-sonnet-5)
 *   OPENAI_API_KEY         → OpenAI-compatible (OPENAI_MODEL, OPENAI_BASE_URL)
 *   neither                → faux mode: scripted model, zero keys, full CLI
 *
 * Sessions live under $KISO_HOME/sessions (default ~/.kiso/sessions) as
 * append-only JSONL. Write/edit/shell tools sit behind the approval policy:
 * the run pauses, asks, and resumes — durably (ADR-0024).
 */

import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAgent, SessionStore, type AgentSession } from "@kiso/runtime";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { CODING_TOOLS } from "@kiso/tools-node";
import type { PermissionPolicy } from "@kiso/runtime";
import { renderEvent, renderSessionLine } from "./render.js";

const PERMISSION_POLICY: PermissionPolicy = {
	rules: [
		{ tool: "read_file", action: "allow" },
		{ tool: "list_dir", action: "allow" },
		{ tool: "search_text", action: "allow" },
		{ tool: "write_file", action: "defer" },
		{ tool: "edit_file", action: "defer" },
		{ tool: "shell", action: "defer" },
	],
	default: "deny",
};

function sessionsDir(): string {
	return join(process.env.KISO_HOME ?? join(homedir(), ".kiso"), "sessions");
}

async function makeAgent() {
	const store = new SessionStore(sessionsDir());

	// Provider wiring: real key → real adapter; none → faux.
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;

	let adapter;
	let model: string;
	if (anthropicKey) {
		const { createAnthropicAdapter } = await import("@kiso/provider-anthropic");
		const { default: Anthropic } = await import("@anthropic-ai/sdk");
		adapter = createAnthropicAdapter(new Anthropic({ apiKey: anthropicKey }));
		model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
	} else if (openaiKey) {
		const { createOpenAICompatAdapter } = await import("@kiso/provider-openai");
		const { default: OpenAI } = await import("openai");
		adapter = createOpenAICompatAdapter(
			new OpenAI({
				apiKey: openaiKey,
				...(process.env.OPENAI_BASE_URL !== undefined ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
			}),
		);
		model = process.env.OPENAI_MODEL ?? "gpt-4o";
	} else {
		console.log("[faux mode — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model]\n");
		adapter = createFauxProvider(fauxScript());
		model = "faux";
	}

	return createAgent({
		model,
		store,
		tools: CODING_TOOLS,
		adapter,
		permissionPolicy: PERMISSION_POLICY,
		systemPrompt:
			"You are kiso, a coding agent. Read files and search before editing. " +
			"Use write_file/edit_file for changes and shell for commands. " +
			"Never claim a file was changed unless a tool confirmed it.",
		maxTurns: 20,
	});
}

/** The keyless demo script: tours the tools so `kiso chat` exercises them. */
function fauxScript(): FauxScript {
	return [
		{
			events: [
				{ type: "text_start" },
				{ type: "text_delta", text: "I'm the faux model. Let me look at the working directory." },
				{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "I see the workspace. What would you like me to inspect or change?" },
				{ type: "stop", reason: "end_turn" },
			],
		},
	];
}

async function showRecovery(session: AgentSession): Promise<void> {
	for (const pending of session.pendingApprovals()) {
		console.log(`⏸ pending approval: ${pending.name} (${JSON.stringify(pending.input).slice(0, 100)})`);
	}
	for (const uncertain of session.uncertainExecutions()) {
		console.log(`⚠ interrupted execution: ${uncertain.name} — was it applied?`);
	}
	if (session.pendingApprovals().length > 0 || session.uncertainExecutions().length > 0) {
		console.log("  resume the session to answer these.\n");
	}
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
async function chat(session: AgentSession): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let currentRun: { abort: () => void } | null = null;

	const askApproval = (decisionId: string, name: string): Promise<boolean> =>
		new Promise((resolve) => {
			rl.question(`approve ${name}? (y/n) `, (answer) => {
				resolve(answer.trim().toLowerCase().startsWith("y"));
			});
		});

	const turn = (input: string): Promise<void> =>
		new Promise((resolve) => {
			const run = session.run(input);
			currentRun = run;
			(async () => {
				for await (const ev of run) {
					const rendered = renderEvent(ev);
					if (rendered.prompt) {
						process.stdout.write(rendered.text);
						const allow = await askApproval(
							(ev as { decisionId: string }).decisionId,
							(ev as { name: string }).name,
						);
						session.approve((ev as { decisionId: string }).decisionId, allow);
					} else {
						process.stdout.write(rendered.text);
					}
				}
				currentRun = null;
				resolve();
			})();
		});

	rl.on("SIGINT", () => {
		if (currentRun) {
			console.log("\n[aborting run]");
			currentRun.abort();
		} else {
			rl.close();
		}
	});

	await showRecovery(session);
	const prompt = (): void => {
		rl.question("you> ", async (line) => {
			if (line.trim().toLowerCase() === "exit" || line.trim() === "") {
				rl.close();
				return;
			}
			await turn(line);
			prompt();
		});
	};
	prompt();
	await new Promise<void>((resolve) => rl.on("close", () => resolve()));
}

/** One-shot: run a single input against an existing session, then exit. */
async function resume(session: AgentSession, input: string): Promise<void> {
	await showRecovery(session);
	for await (const ev of session.run(input)) {
		const rendered = renderEvent(ev);
		process.stdout.write(rendered.text);
	}
}

async function main(): Promise<void> {
	const [command, arg] = process.argv.slice(2);
	const agent = await makeAgent();

	switch (command) {
		case "chat": {
			const id = arg ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
			const session = await agent.session({ id });
			console.log(`session ${id}\n`);
			await chat(session);
			break;
		}
		case "resume": {
			if (!arg) {
				console.error("usage: kiso resume <sessionId> [\"prompt\"]");
				process.exit(2);
			}
			const session = await agent.session({ id: arg });
			await resume(session, process.argv[3] ?? "continue");
			break;
		}
		case "sessions": {
			for (const meta of agent.sessions()) {
				console.log(renderSessionLine(meta));
			}
			break;
		}
		case "help":
		case undefined:
		default:
			console.log(
				"kiso — the coding-agent reference product\n\n" +
					"  kiso chat [sessionId]   interactive session\n" +
					"  kiso resume <id> [prompt]   continue a session (one-shot)\n" +
					"  kiso sessions           list durable sessions\n" +
					"  kiso help               this help\n",
			);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
