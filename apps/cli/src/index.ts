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
import { createAgent, SessionStore, type AgentDefinition, type AgentSession } from "@kiso/runtime";
import { createFauxProvider, type FauxScript } from "@kiso/evals";
import { createCodingTools } from "@kiso/tools-node";
import type { PermissionPolicy } from "@kiso/runtime";
import { escapeTerminal, renderEvent, renderSessionLine } from "./render.js";

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

	// Provider wiring (F 组): the CLI never imports provider SDKs directly —
	// the runtime's lazy provider resolution owns them. Real key → real
	// provider; none → faux.
	const anthropicKey = process.env.ANTHROPIC_API_KEY;
	const openaiKey = process.env.OPENAI_API_KEY;

	let provider: "anthropic" | "openai-compat" | undefined;
	let model: string;
	if (anthropicKey) {
		provider = "anthropic";
		model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
	} else if (openaiKey) {
		provider = "openai-compat";
		model = process.env.OPENAI_MODEL ?? "gpt-4o";
	} else {
		console.log("[faux mode — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model]\n");
		model = "faux";
	}

	const definition: AgentDefinition = {
		model,
		store,
		// Area 5: the coding tools are bound to the workspace — every path
		// they touch is canonicalized inside cwd, escapes are refused.
		tools: [...createCodingTools({ workspaceRoot: process.cwd() })],
		permissionPolicy: PERMISSION_POLICY,
		systemPrompt:
			"You are kiso, a coding agent. Read files and search before editing. " +
			"Use write_file/edit_file for changes and shell for commands. " +
			"Never claim a file was changed unless a tool confirmed it.",
		maxTurns: 20,
		...(provider !== undefined
			? {
					provider,
					apiKey: (anthropicKey ?? openaiKey) as string,
					...(process.env.OPENAI_BASE_URL !== undefined ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
				}
			: { adapter: createFauxProvider(fauxScript()) }),
	};
	return createAgent(definition);
}

/**
 * The keyless demo script: tours the tools so `kiso chat` exercises them.
 * FOUR turns: each user turn consumes two model rounds (call → result →
 * summary), so at least two consecutive user turns work in one process
 * (F 组).
 */
function fauxScript(): FauxScript {
	return [
		{
			events: [
				{ type: "text_start" },
				{ type: "text_delta", text: "I'm the faux model. Let me look at the working directory." },
				{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
				{ type: "stop", reason: "tool_use" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "I see the workspace. What would you like me to inspect or change?" },
				{ type: "stop", reason: "end_turn" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "The faux model is still here, with full context." },
				{ type: "stop", reason: "end_turn" },
			],
		},
		{
			events: [
				{ type: "text_delta", text: "And this is the end of the scripted tour." },
				{ type: "stop", reason: "end_turn" },
			],
		},
	];
}
/**
 * Ask the human a question. Non-interactive stdin (piped, CI) cannot wait
 * forever: approvals auto-deny and uncertain executions auto-abandon, both
 * printed loudly — never silently ignored, never hung (Area 7).
 *
 * 八: the question is ABORTABLE — a pending rl.question is registered in
 * `pendingAsk` and the SIGINT handler resolves it, so Ctrl+C unblocks a
 * question that is waiting for a line instead of hanging the REPL.
 */
let pendingAsk: (() => void) | null = null;
function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	if (!process.stdin.isTTY) {
		console.log(`[non-interactive — no human to ask: ${question}]`);
		return Promise.resolve("");
	}
	return new Promise((resolve) => {
		pendingAsk = () => {
			pendingAsk = null;
			resolve(""); // the run is aborting — the conservative answer
		};
		rl.question(question, (answer) => {
			pendingAsk = null;
			resolve(answer);
		});
	});
}

/** Decide every uncertain execution with the human (r)erun/(a)bandon. */
async function resolveUncertains(
	session: AgentSession,
	rl: ReturnType<typeof createInterface>,
	isCancelled: () => boolean,
): Promise<void> {
	for (const uncertain of session.uncertainExecutions()) {
		const answer = await ask(
			rl,
			`⚠ interrupted execution: ${escapeTerminal(uncertain.name)} (${uncertain.executionId}) — did it apply? (r)erun / (a)bandon: `,
		);
		if (isCancelled()) return; // Ctrl+C with no run: stop deciding, exit
		const resolution = answer.trim().toLowerCase().startsWith("r") ? "rerun" : "abandoned";
		await session.resolveUncertain(uncertain.executionId, resolution);
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
): Promise<import("@kiso/core").Event | undefined> {
	let last: import("@kiso/core").Event | undefined;
	for await (const ev of run) {
		last = ev;
		if (ev.type === "uncertain_pending") {
			// C 组: a failed non-idempotent execution pauses for a verdict.
			console.log(
				`\n⚠ ${escapeTerminal(ev.name)} FAILED — the side effect may have applied.\n  ${escapeTerminal(ev.error)}\n`,
			);
			const answer = await ask(rl, `did it apply? (r)erun / (a)bandon: `);
			await session.resolveUncertain(ev.executionId, answer.trim().toLowerCase().startsWith("r") ? "rerun" : "abandoned");
			continue;
		}
		const rendered = renderEvent(ev);
		if (rendered.prompt) {
			process.stdout.write(rendered.text);
			const decisionId = (ev as { decisionId: string }).decisionId;
			const name = (ev as { name: string }).name;
			// 八: the tool name is model text — escaped on every output path.
			const answer = await ask(rl, `approve ${escapeTerminal(name)}? (y/n) `);
			await session.approve(decisionId, answer.trim().toLowerCase().startsWith("y"));
		} else {
			process.stdout.write(rendered.text);
		}
	}
	return last;
}

/**
 * 八: a faux-mode run whose scripted turns are exhausted must NOT print a
 * provider error and exit 0 — the honest outcome is a loud message and a
 * non-zero exit. Only the exhaustion signature (the empty stream after the
 * declared turns) triggers the script-specific message; any other error
 * terminal still exits non-zero.
 */
function failOnFauxExhaustion(last: import("@kiso/core").Event | undefined, faux: boolean): void {
	if (!faux) return;
	if (last?.type !== "terminal" || last.outcome.kind !== "error") return;
	const message = last.outcome.error.message;
	console.error(
		message.startsWith("provider stream ended without a stop event")
			? "\n[faux mode] the scripted demo turns are exhausted — set ANTHROPIC_API_KEY or OPENAI_API_KEY for a real model"
			: `\n[faux mode] the scripted model failed: ${escapeTerminal(message.slice(0, 200))}`,
	);
	process.exit(1);
}

/** Interactive REPL: stream events, pause for approvals, Ctrl+C aborts. */
async function chat(session: AgentSession, faux: boolean): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let currentRun: { abort: () => void } | null = null;
	let cancelled = false;

	const turn = (input: string): Promise<void> =>
		new Promise((resolve) => {
			const run = session.run(input);
			currentRun = run;
			(async () => {
				let last: import("@kiso/core").Event | undefined;
				try {
					last = await consumeRun(session, run, rl);
				} catch (err) {
					// A run failure must not freeze the REPL (review finding
					// 11): surface it and re-arm the prompt.
					console.error(`\n[run failed] ${err instanceof Error ? err.message : String(err)}\n`);
				}
				currentRun = null;
				// 八: a faux script that ran out of declared turns exits
				// loudly with a non-zero status — never a silent status 0.
				failOnFauxExhaustion(last, faux);
				// 八: after EVERY turn the prompt is re-armed — the human
				// never types blind after the first turn.
				rl.setPrompt("you> ");
				rl.prompt();
				resolve();
			})();
		});

	rl.on("SIGINT", () => {
		if (currentRun) {
			// 八: Ctrl+C cancels BOTH the pending question (if one is
			// awaiting a line) and the run — the run then writes its unique
			// aborted terminal, which the consumer keeps consuming.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else if (!cancelled) {
			cancelled = true;
			console.log("\n[exit requested]");
			pendingAsk?.(); // unblock a startup question
			rl.close();
		}
	});

	// Recovery first: a session with a dangling pause or uncertain
	// executions must resolve them BEFORE the REPL accepts new turns —
	// otherwise the interrupted run dangles while a new one starts.
	// 八: the startup resume is bound to currentRun — Ctrl+C during it
	// aborts the recovery, exactly like the interactive turns.
	await resolveUncertains(session, rl, () => cancelled);
	if (!cancelled) {
		const recoveryRun = session.resume();
		currentRun = recoveryRun;
		const last = await consumeRun(session, recoveryRun, rl);
		currentRun = null;
		failOnFauxExhaustion(last, faux);
	}
	if (cancelled) {
		rl.close();
		await new Promise<void>((resolve) => rl.on("close", () => resolve()));
		return;
	}
	// A PERSISTENT line listener: rl.question attaches a one-shot listener,
	// and a line arriving while no question is pending is silently LOST
	// (piped stdin). The REPL loop must never drop a user turn (F 组).
	// Turns are SERIALIZED on a chain — piped lines arrive faster than
	// turns complete, and concurrent runs are forbidden.
	let chain: Promise<void> = Promise.resolve();
	rl.on("line", (line) => {
		if (line.trim().toLowerCase() === "exit" || line.trim() === "") {
			rl.close();
			return;
		}
		chain = chain.then(() => turn(line));
	});
	rl.setPrompt("you> ");
	rl.prompt();
	await new Promise<void>((resolve) => rl.on("close", () => resolve()));
	await chain; // never exit while a turn is in flight
}

/**
 * Resume = the RECOVERY flow (Area 2/7): uncertain executions are decided,
 * the interrupted run is continued via session.resume() — never faked with
 * a new prompt. An optional prompt afterwards starts a genuinely new turn.
 * E 组: SIGINT aborts the run being resumed; every exit path closes the
 * session store so no lock is left behind.
 */
async function resume(session: AgentSession, prompt: string | undefined, faux: boolean): Promise<void> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	let currentRun: { abort: () => void } | null = null;
	const withRun = async (run: ReturnType<AgentSession["resume"]>): Promise<void> => {
		currentRun = run;
		try {
			const last = await consumeRun(session, run, rl);
			failOnFauxExhaustion(last, faux);
		} finally {
			currentRun = null;
		}
	};
	rl.on("SIGINT", () => {
		if (currentRun) {
			// 八: Ctrl+C cancels the pending question AND the run.
			console.log("\n[aborting run]");
			pendingAsk?.();
			currentRun.abort();
		} else {
			rl.close();
		}
	});
	await resolveUncertains(session, rl, () => false);
	await withRun(session.resume());
	if (prompt !== undefined && prompt !== "") {
		await withRun(session.run(prompt));
	}
	rl.close();
}

async function main(): Promise<void> {
	const [command, arg] = process.argv.slice(2);
	const agent = await makeAgent();
	// 八: faux mode is the keyless demo script — an exhausted script must
	// exit non-zero, never masquerade as a successful provider run.
	const faux = process.env.ANTHROPIC_API_KEY === undefined && process.env.OPENAI_API_KEY === undefined;

	try {
		switch (command) {
			case "chat": {
				const id = arg ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
				const session = await agent.session({ id });
				console.log(`session ${id}\n`);
				await chat(session, faux);
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
				await resume(session, prompt, faux);
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
	} finally {
		// E 组: every normal and abnormal exit releases the fds and writer
		// locks — no lock file is left behind.
		agent.close();
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
