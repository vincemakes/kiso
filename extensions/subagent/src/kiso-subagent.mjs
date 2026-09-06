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
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
				additionalProperties: false,
			},
		},
	},
	required: ["tasks"],
	additionalProperties: false,
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
					// CX-1 F6 (audit F6): every delegate invocation mints its own
					// identity — ToolContext carries none — so two invocations never
					// share a child session, and the result is located by identity.
					const delegationId = randomBytes(12).toString("hex");
					const manifestDir = join(sessionsDir, "subagent");
					mkdirSync(manifestDir, { recursive: true });
					const sections = await runLimited(tasks, CONCURRENCY, (task, i) =>
						runChild({
							childId: `sub-${parentId}-${delegationId}-${i + 1}-${task.role}`,
							manifestDir,
							manifest: { parentId, delegationId, index: i + 1, role: task.role, startedAt: Date.now() },
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
					// W12: the blob opens with a machine-readable summary line —
					// the ONE-LINE shape the TUI's settled row renders (└ N
					// tool calls · R roles · F failed · /last for the report).
					// The per-section text below is unchanged — the model's
					// view is preserved, the summary is additive.
					const toolCalls = sections.reduce((n, s) => n + (s.toolCalls ?? 0), 0);
					const roles = new Set(tasks.map((t) => t.role)).size;
					const failed = sections.filter((s) => s.failed).length;
					const summary = `summary: ${toolCalls} tool calls · ${roles} role${roles === 1 ? "" : "s"} · ${failed} failed`;
					return { content: `${summary}\n${sections.map((s) => s.text).join("\n")}`, isError: sections.every((s) => s.failed) };
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

async function runChild({ childId, role, task, sessionsDir, bin, timeout, signal, parentCwd, manifestDir, manifest }) {
	// implementer isolation: a detached git worktree; the child works inside
	// it and its diff comes back. Non-git parents fail the task HONESTLY.
	// CX-1 F6: the manifest binds this invocation to its child session
	// BEFORE anything runs — the durable record of "which run is mine".
	if (manifestDir !== undefined) {
		writeFileSync(join(manifestDir, `${childId}.json`), `${JSON.stringify({ ...manifest, childId })}\n`, "utf8");
	}
	let worktree = null;
	let baseRev = null;
	let childCwd = parentCwd;
	if (role === "implementer") {
		worktree = mkdtempSync(join(tmpdir(), "kiso-subagent-wt-"));
		try {
			execFileSync("git", ["-C", parentCwd, "worktree", "add", "--detach", worktree], { stdio: "ignore" });
			// CX-1 F2: the base revision — a child that COMMITS is compared
			// against it, never read as "unchanged".
			baseRev = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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
		// CX-1 F5 (audit F5): the task travels as a FILE the child reads into
		// exactly one user turn — never as stdin lines (the non-TTY path is a
		// line-oriented readline: newlines were turns, `exit` ended input).
		const taskPath = join(manifestDir ?? policyDir, `${childId}.task`);
		writeFileSync(taskPath, task, "utf8");
		const { code, stdout, killed } = await runProcess(childId, bin, childCwd, policyDir, taskPath, timeout, signal);
		const extraction = await extractChildResult(sessionsDir, childId, `exit ${code}\n${stdout}`);
		let failed = code !== 0 || killed !== null || extraction.failed;
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
			// CX-1 F2 (audit F2): tri-state collection. `collected` is earned
			// (the patch file closed AND git exited 0); a failure PRESERVES the
			// worktree and says so; "consumed" is undefined this batch, so a
			// worktree with changes is always kept and named.
			const patchPath = join(manifestDir ?? tmpdir(), `${childId}.patch`);
			const col = await collectWorktree(worktree, baseRev, patchPath);
			if (col.kind === "collected") {
				keepWorktree = true;
				text += `\n  diff:\n${col.stat}\n  patch: ${patchPath}`;
				if (col.bytes <= INLINE_PATCH_BYTES) text += `\n${readFileSync(patchPath, "utf8")}`;
				else text += `\n  (patch is ${col.bytes} bytes — read it with the shell: cat ${patchPath}, or git -C ${worktree} diff ${baseRev})`;
				text += `\n  worktree kept at: ${worktree}`;
			} else if (col.kind === "failed") {
				keepWorktree = true;
				failed = true;
				text += `\n  FAILED: collecting the worktree's changes: ${col.reason}${col.partialPath !== undefined ? ` (partial patch at ${col.partialPath})` : ""}\n  worktree kept at: ${worktree}`;
			}
		}
		return { failed, text, toolCalls: extraction.toolCalls };
	} finally {
		rmSync(policyDir, { recursive: true, force: true });
		if (worktree !== null && !keepWorktree) removeWorktree(parentCwd, worktree);
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
function runProcess(childId, bin, cwd, policyDir, taskPath, timeout, signal) {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const child = spawn(process.execPath, [bin, "chat", childId, "--task-file", taskPath], {
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
	child.stdin.end(); // CX-1 F5: nothing rides stdin — the task is the file
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
			const records = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.filter((l) => l !== "")
				.map((l) => JSON.parse(l));
			// CX-1 F6: the child session is fresh by construction, so its log
			// holds exactly ONE run — the result is located by that identity,
			// never by position. More than one run is ambiguous, and reported.
			const runIds = new Set(records.map((r) => r.runId).filter((id) => typeof id === "string"));
			if (runIds.size > 1) {
				return { outcome: "ambiguous", toolCalls: 0, text: "", failed: true, reason: `child session ${childId} holds ${runIds.size} runs — the result cannot be located by identity`, diag };
			}
			events = records.map((r) => r.event ?? r);
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

/** CX-1 F2: a patch body this size or smaller rides inline in the section;
 *  larger ones are named by path (the parent reads them with the shell). */
const INLINE_PATCH_BYTES = 64 * 1024;

/** CX-1 F2: the implementer's changes against the BASE revision, streamed to
 *  a file — intent-to-add first so NEW files are part of the diff. Three
 *  states, never a null that means two things:
 *    { kind: "unchanged" }
 *    { kind: "collected", stat, bytes }   — file closed AND git exited 0
 *    { kind: "failed", reason, partialPath? }
 *  Old shape: execFileSync buffered the patch, threw ENOBUFS above 1 MiB,
 *  and the catch returned null — "no changes" — so the worktree was
 *  deleted with the work in it. */
async function collectWorktree(worktree, baseRev, patchPath) {
	let stat;
	try {
		execFileSync("git", ["-C", worktree, "add", "-N", "."], { stdio: "ignore" });
		const base = baseRev ?? "HEAD";
		stat = execFileSync("git", ["-C", worktree, "diff", "--stat", base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
		if (stat === "") return { kind: "unchanged" };
	} catch (err) {
		return { kind: "failed", reason: `git diff --stat: ${msg(err)}` };
	}
	let fd = null;
	try {
		fd = openSync(patchPath, "w");
		const code = await new Promise((resolve, reject) => {
			const p = spawn("git", ["-C", worktree, "diff", baseRev ?? "HEAD"], { stdio: ["ignore", fd, "pipe"] });
			let stderr = "";
			p.stderr.on("data", (d) => {
				stderr += String(d);
			});
			p.on("error", reject);
			p.on("exit", (c) => resolve({ c, stderr }));
		});
		closeSync(fd);
		fd = null;
		if (code.c !== 0) return { kind: "failed", reason: `git diff exited ${code.c}: ${code.stderr.trim()}`, partialPath: patchPath };
		return { kind: "collected", stat, bytes: statSync(patchPath).size };
	} catch (err) {
		if (fd !== null) closeSync(fd);
		return { kind: "failed", reason: `git diff: ${msg(err)}`, partialPath: patchPath };
	}
}

/** CX-1 F2: an UNCHANGED worktree leaves through git, so the registration
 *  under .git/worktrees goes with it; the directory fallback covers a git
 *  that no longer recognizes it. */
function removeWorktree(parentCwd, worktree) {
	try {
		execFileSync("git", ["-C", parentCwd, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
	} catch {
		rmSync(worktree, { recursive: true, force: true });
		try {
			execFileSync("git", ["-C", parentCwd, "worktree", "prune"], { stdio: "ignore" });
		} catch {
			// nothing left to prune
		}
	}
}

function failSection(childId, role, task, reason) {
	return { failed: true, text: `[subagent] ${role}: ${task}\n  FAILED: ${reason}`, toolCalls: 0 };
}

const msg = (err) => (err instanceof Error ? err.message : String(err));
