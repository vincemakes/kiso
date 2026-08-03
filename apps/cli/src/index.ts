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
import { createCodingTools } from "@kiso/tools-node";
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
		// Area 5: the coding tools are bound to the workspace — every path
		// they touch is canonicalized inside cwd, escapes are refused.
		tools: [...createCodingTools({ workspaceRoot: process.cwd() })],
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

/**
 * Ask the human a question. Non-interactive stdin (piped, CI) cannot wait
 * forever: approvals auto-deny and uncertain executions auto-abandon, both
 * printed loudly — never silently ignored, never hung (Area 7).
 */
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	if (!process.stdin.isTTY) {
		console.log(`[non-interactive — no human to ask: ${question}]`);
		return Promise.resolve("");
	}
	return new Promise((resolve) => rl.question(question, resolve));
}

/** Decide every uncertain execution with the human (r)erun/(a)bandon. */
async function resolveUncertains(session: AgentSession, rl: ReturnType<typeof createInterface>): Promise<void> {
	for (const uncertain of session.uncertainExecutions()) {
		const answer = await ask(rl, `⚠ interrupted execution: ${uncertain.name} — did it apply? (r)erun / (a)bandon: `);
		const resolution = answer.trim().toLowerCase().startsWith("r") ? "rerun" : "abandoned";
		session.resolveUncertain(uncertain.callId, resolution);
		console.log(`  ${resolution}\n`);
	}
}

/**
 * Consume a run, answering approval pauses as they arrive. `resumeMode`
 * marks a session.resume() continuation.
 */
async function consumeRun(
	session: AgentSession,
	run: AsyncIterable<import("@kiso/core").Event>,
	rl: ReturnType<typeof createInterface>,
): Promise<void> {
	for await (const ev of run) {
		const rendered = renderEvent(ev);
		if (rendered.prompt) {
			process.stdout.write(rendered.text);
			const decisionId = (ev as { decisionId: string }).decisionId;
			const name = (ev as { name: string }).name;
			const answer = await ask(rl, `approve ${name}? (y/n) `);
			session.approve(decisionId, answer.trim().toLowerCase().startsWith("y"));
		} else {
			process.stdout.write(rendered.text);
		}
	}
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
async function chat(session: AgentSession): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let currentRun: { abort: () => void } | null = null;

	const turn = (input: string): Promise<void> =>
		new Promise((resolve) => {
			const run = session.run(input);
			currentRun = run;
			(async () => {
				try {
					await consumeRun(session, run, rl);
				} catch (err) {
					// A run failure must not freeze the REPL (review finding
					// 11): surface it and re-arm the prompt.
					console.error(`\n[run failed] ${err instanceof Error ? err.message : String(err)}\n`);
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

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	await resolveUncertains(session, rl);
	await consumeRun(session, session.resume(), rl);
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

/**
 * Resume = the RECOVERY flow (Area 2/7): uncertain executions are decided,
 * the interrupted run is continued via session.resume() — never faked with
 * a new prompt. An optional prompt afterwards starts a genuinely new turn.
 */
async function resume(session: AgentSession, prompt?: string): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	await resolveUncertains(session, rl);
	await consumeRun(session, session.resume(), rl);
	if (prompt !== undefined && prompt !== "") {
		await consumeRun(session, session.run(prompt), rl);
	}
	rl.close();
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
			// argv[4] is the optional prompt; argv[3] is the session id
			// (argv = [node, script, resume, id, prompt?]).
			const prompt = process.argv[4];
			const session = await agent.session({ id: arg });
			await resume(session, prompt);
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
