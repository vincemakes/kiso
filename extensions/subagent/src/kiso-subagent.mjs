/**
 * kiso (foundation) official subagent extension — ④: child kiso processes with
 * role policies, kernel untouched.
 *
 * `delegate` spawns child kiso processes (the SAME binary) that work in
 * isolated, role-policy-gated environments and report back from their OWN
 * durable session JSONL (children land in the normal sessions directory —
 * durable, auditable, resumable after a parent crash). Depth is guarded
 * (KISO_SUBAGENT_DEPTH ≥ 1 → no delegate) so children can never nest.
 *
 * Approval: no auto-allow — delegate falls in the ask tier, so a human
 * sees every delegation (ruling A: the ask reaches the human directly).
 *
 * Zero runtime dependencies: child_process/fs/os/path are builtins.
 *
 * finding #8: this extension holds NO persistent resources — children are
 * spawned per call and exit on their own, the role-policy temp dirs are
 * cleaned in runChild's finally — so NO dispose is needed, explicitly.
 */

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** Default per-child timeout (ms) — a subagent must never hang the parent. */
const TIMEOUT_MS = 10 * 60 * 1000;
/** Max simultaneous children — the concurrency cap (mapLimited). */
const CONCURRENCY = 4;

const SIX_TOOLS = ["read_file", "list_dir", "search_text", "write_file", "edit_file", "shell"];
const READ_ONLY = ["read_file", "list_dir", "search_text"];
const ROLES = ["explorer", "implementer", "reviewer", "tester"];

const DELEGATE_PARAMETERS = {
	type: "object",
	properties: {
		tasks: {
			type: "array",
			minItems: 1,
			maxItems: 8,
			items: {
				type: "object",
				properties: {
					role: { type: "string", enum: ROLES },
					task: { type: "string", minLength: 1 },
				},
				required: ["role", "task"],
			},
		},
	},
	required: ["tasks"],
};

export default async function createSubagentExtension() {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	if (depth >= 1) return { name: "subagent", tools: [] }; // depth guard — no nesting
	return {
		name: "subagent",
		tools: [
			{
				name: "delegate",
				description: "run subagent tasks (explorer/implementer/reviewer/tester) in child kiso processes",
				parameters: DELEGATE_PARAMETERS,
				execute: async (input, ctx) => {
					const tasks = ((input ?? {}).tasks ?? []).slice(0, 8);
					if (tasks.length === 0) return { content: "delegate: no tasks", isError: true };
					const sessionsDir = join(process.env.KISO_HOME ?? join(homedir(), ".kiso"), "sessions");
					// P3: the loop now threads the session id through
					// ToolContext.sessionId — the discovery heuristic below is
					// kept ONLY as a fallback for direct tool use / tests.
					const parentId = ctx.sessionId ?? discoverParentId(sessionsDir);
					const bin = process.env.KISO_SUBAGENT_BIN ?? process.argv[1];
					const timeout = Number.parseInt(process.env.KISO_SUBAGENT_TIMEOUT_MS ?? "", 10) || TIMEOUT_MS;
					const sections = await runLimited(tasks, CONCURRENCY, (task, i) =>
						runChild({
							childId: `sub-${parentId}-${i + 1}-${task.role}`,
							role: task.role,
							task: task.task,
							sessionsDir,
							bin,
							timeout,
							signal: ctx.signal,
							parentCwd: process.cwd(),
						}),
					);
					// Partial success is not overall failure — only ALL failed
					// makes the whole result an error.
					return { content: sections.map((s) => s.text).join("\n"), isError: sections.every((s) => s.failed) };
				},
			},
		],
	};
}

/**
 * The parent session id for the child naming: the explicit
 * KISO_SESSION_ID wins; otherwise the NEWEST *.jsonl in the sessions dir
 * IS the parent (its approval events were just persisted before this tool
 * ran); a constant fallback covers direct tool use / tests.
 */
function discoverParentId(sessionsDir) {
	if (process.env.KISO_SESSION_ID !== undefined) return process.env.KISO_SESSION_ID;
	let newest = null;
	let newestMtime = -1;
	try {
		for (const file of readdirSync(sessionsDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const st = statSync(join(sessionsDir, file));
			if (st.mtimeMs > newestMtime) {
				newestMtime = st.mtimeMs;
				newest = file.slice(0, -".jsonl".length);
			}
		}
	} catch {
		// no sessions dir yet
	}
	return newest ?? "parent";
}

/** mapLimited — at most `limit` tasks in flight at once. */
function runLimited(items, limit, fn) {
	const results = new Array(items.length);
	let next = 0;
	async function worker() {
		while (true) {
			const i = next;
			next += 1;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	}
	return Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker)).then(() => results);
}

async function runChild({ childId, role, task, sessionsDir, bin, timeout, signal, parentCwd }) {
	// implementer isolation: a detached git worktree; the child works inside
	// it and its diff comes back. Non-git parents fail the task HONESTLY.
	let worktree = null;
	let childCwd = parentCwd;
	if (role === "implementer") {
		worktree = mkdtempSync(join(tmpdir(), "kiso-subagent-wt-"));
		try {
			execFileSync("git", ["-C", parentCwd, "worktree", "add", "--detach", worktree], { stdio: "ignore" });
			childCwd = worktree;
		} catch (err) {
			rmSync(worktree, { recursive: true, force: true });
			return failSection(childId, role, task, `implementer needs a git repository: ${msg(err)}`);
		}
	}
	// The child-only role policy: one .mjs in its own temp extensions dir.
	const policyDir = mkdtempSync(join(tmpdir(), "kiso-subagent-policy-"));
	writeFileSync(join(policyDir, "policy.mjs"), rolePolicyContent(role), "utf8");
	let keepWorktree = false;
	try {
		const { code, stdout, killed } = await runProcess(childId, bin, childCwd, policyDir, task, timeout, signal);
		const extraction = await extractChildResult(sessionsDir, childId, `exit ${code}\n${stdout}`);
		const failed = code !== 0 || killed !== null || extraction.failed;
		let text = `[subagent] ${role}: ${task}\n  outcome: ${extraction.outcome}\n  tools: ${extraction.toolCalls}`;
		if (killed === "timeout") {
			text += `\n  FAILED: timed out after ${timeout}ms (the child process group was killed)`;
		} else if (killed === "abort") {
			text += "\n  FAILED: aborted by the parent run (the child process group was killed)";
		} else if (code !== 0) {
			text += `\n  FAILED: the child exited with code ${code}\n${stdout}`;
		} else if (extraction.failed) {
			text += `\n  FAILED: ${extraction.reason}${extraction.diag !== "" ? `\n${extraction.diag}` : ""}`;
		}
		if (extraction.text !== "") text += `\n${extraction.text}`;
		if (role === "implementer") {
			const diff = worktreeDiff(worktree);
			if (diff !== null) {
				keepWorktree = true;
				text += `\n  diff:\n${diff}\n  worktree kept at: ${worktree}`;
			}
		}
		return { failed, text };
	} finally {
		rmSync(policyDir, { recursive: true, force: true });
		if (worktree !== null && !keepWorktree) rmSync(worktree, { recursive: true, force: true });
	}
}

/**
 * The child process: same binary, detached (own process group — a timeout
 * or abort SIGKILLs the WHOLE group), input piped as the task line + exit
 * (the same shape the CLI e2e drivers use), stdout captured for
 * diagnostics only — the RESULT comes from the child's session JSONL.
 *
 * ENV — deliberately the parent's full environment PLUS the depth guard
 * and the role policy dir. Note the difference from the shell tool (#7):
 * shell = arbitrary commands, stripped by default; delegate = a CONTROLLED
 * spawn the human just approved in the ask tier, so the provider
 * credentials the parent was trusted with ride along.
 */
function runProcess(childId, bin, cwd, policyDir, task, timeout, signal) {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const child = spawn(process.execPath, [bin, "chat", childId], {
		cwd,
		env: {
			...process.env,
			KISO_SUBAGENT_DEPTH: String(depth + 1),
			KISO_EXTENSIONS_DIR: policyDir,
			// Modes: a headless child has no human — the mode tiers'
			// ask would stall it. Bypass is the neutral tier here; the
			// role policy dir (allow/deny only — a child must never
			// see an ask) stays the child's ONLY gate, exactly as
			// before the mode tiers existed (deny>ask>allow honors its
			// denials; the mode's all-allow never overrides them).
			KISO_MODE: "bypass",
		},
		detached: true,
		stdio: ["pipe", "pipe", "inherit"],
	});
	child.stdin.write(`${task}\nexit\n`);
	child.stdin.end();
	let stdout = "";
	child.stdout.on("data", (d) => {
		stdout += String(d);
	});
	const exited = new Promise((resolve) => {
		child.on("exit", (code, sig) => resolve({ code: code ?? -1, signal: sig }));
	});
	let killed = null;
	const killGroup = () => {
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {
			// already gone
		}
	};
	const timer = setTimeout(() => {
		killed = "timeout";
		killGroup();
	}, timeout);
	const onAbort = () => {
		killed = "abort";
		killGroup();
	};
	if (signal?.aborted) onAbort();
	else signal?.addEventListener("abort", onAbort, { once: true });
	// The timeout and abort listener live until the child EXITS — clearing
	// them in a finally around the setup would disarm them before the exit.
	return exited.then(({ code }) => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
		return { code, stdout, killed };
	});
}

/** The role policy: read-only for explorer/reviewer, the full six for
 *  implementer/tester. Only allow/deny — NEVER ask (a headless child cannot
 *  answer an approval prompt; ask would deadlock). */
export function rolePolicyContent(role) {
	const allowed = role === "implementer" || role === "tester" ? SIX_TOOLS : READ_ONLY;
	return `export default { name: "subagent-${role}", approvals: [{
	decide(call) {
		if (${JSON.stringify(allowed)}.includes(call.name)) return { action: "allow" };
		return { action: "deny", reason: "not allowed for the ${role} role" };
	}
}] };
`;
}

/**
 * The RESULT source (hard clause): the child's own session JSONL — its
 * terminal outcome, final assistant text (a projection-equivalent parse:
 * the text_delta events since the last message boundary), and its tool
 * call count. stdout is NEVER a result source — it rides along only as a
 * diagnostic on a non-zero exit or a missing JSONL.
 */
export async function extractChildResult(sessionsDir, childId, diag) {
	const file = join(sessionsDir, `${childId}.jsonl`);
	// The child's exit event can land a beat before its final JSONL write
	// (the terminal line) is visible — retry briefly before giving up.
	let events = null;
	let lastErr = null;
	for (let attempt = 0; attempt < 10 && (events === null || !events.some((e) => e.type === "terminal")); attempt++) {
		try {
			// The store's JSONL records are {runId, ts, event} wrappers —
			// unwrap; bare events (fixtures) pass through.
			events = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l))
				.map((r) => r.event ?? r);
		} catch (err) {
			lastErr = err;
			events = null;
		}
		if (events === null || !events.some((e) => e.type === "terminal")) await new Promise((r) => setTimeout(r, 200));
	}
	if (events === null) {
		return { outcome: "missing", toolCalls: 0, text: "", failed: true, reason: `child session JSONL missing: ${msg(lastErr)}`, diag };
	}
	const terminal = events.find((e) => e.type === "terminal");
	if (terminal === undefined) {
		return { outcome: "no-terminal", toolCalls: countToolCalls(events), text: finalText(events), failed: true, reason: "child session has no terminal", diag };
	}
	const outcome = terminal.outcome?.kind ?? "unknown";
	const toolCalls = countToolCalls(events);
	const text = finalText(events);
	return {
		outcome,
		toolCalls,
		text,
		failed: outcome !== "completed",
		reason: outcome === "completed" ? "" : `child ended with ${outcome}`,
		diag: outcome === "completed" ? "" : diag,
	};
}

function countToolCalls(events) {
	return events.filter((e) => e.type === "tool_call_end").length;
}

/** Projection-equivalent: the assistant text since the last flush boundary. */
function finalText(events) {
	let text = "";
	for (const e of events) {
		if (e.type === "text_delta") text += e.text;
		else if (e.type === "tool_result" || e.type === "user_input") text = "";
	}
	return text;
}

/** The implementer's changes: git diff (with its --stat header) over the
 *  worktree — intent-to-add first so NEW files are part of the diff, not
 *  silently invisible to `git diff`. null = no changes. */
function worktreeDiff(worktree) {
	try {
		execFileSync("git", ["-C", worktree, "add", "-N", "."], { stdio: "ignore" });
		const stat = execFileSync("git", ["-C", worktree, "diff", "--stat"], { encoding: "utf8" }).trim();
		const diff = execFileSync("git", ["-C", worktree, "diff"], { encoding: "utf8" });
		if (stat === "" && diff.trim() === "") return null;
		return `${stat}\n${diff}`;
	} catch {
		return null;
	}
}

function failSection(childId, role, task, reason) {
	return { failed: true, text: `[subagent] ${role}: ${task}\n  FAILED: ${reason}` };
}

const msg = (err) => (err instanceof Error ? err.message : String(err));
