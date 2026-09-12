/**
 * kiso official subagent extension — ④: child kiso processes with
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
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Default per-child timeout (ms) — a subagent must never hang the parent. */
const TIMEOUT_MS = 10 * 60 * 1000;
/** Max simultaneous children — the concurrency cap (mapLimited). */
const CONCURRENCY = 4;

const SIX_TOOLS = ["read_file", "list_dir", "search_text", "write_file", "edit_file", "shell"];
const READ_ONLY = ["read_file", "list_dir", "search_text"];
const ROLES = ["explorer", "implementer", "reviewer", "tester"];

// DT1a-F2 (owner dogfood 2026-09-08): the model's first delegate call was
// refused twice — `scope` on an explorer, then an `acceptance` naming no
// configured check — because nothing in the schema said where scope applies
// or which checks exist. The field descriptions say so, and the configured
// check and profile names are written into the schema when the extension
// loads (the tool table is snapshotted per request — F7b — so this is the
// table the model reads).
const delegateParameters = (cfg) => ({
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
					// DT-1a: the contract's inputs. scope = allowed WRITE paths (globs,
					// relative to the worktree) — a scoped task has NO shell tool;
					// acceptance names a configured check ({ check }) or a parent-held
					// evaluator ({ evaluator: absolute path outside the project }) —
					// never a command; model names a configured profile; after names
					// a completed implementer's childId (tester only): the tester runs
					// in that worktree.
					scope: {
						type: "array",
						items: { type: "string", minLength: 1 },
						maxItems: 32,
						description: "implementer/tester only (explorer or reviewer with scope: refused). Write-path globs; a scoped child has no shell; a write outside the scope is refused",
					},
					acceptance: {
						type: "object",
						properties: { check: { type: "string", minLength: 1 }, evaluator: { type: "string", minLength: 1 } },
						additionalProperties: false,
						description: `implementer/tester only, optional. Exactly one of { check } (user-configured; now: ${Object.keys(cfg.checks).length ? Object.keys(cfg.checks).join(", ") : "none — omit acceptance"}) or { evaluator } (absolute path OUTSIDE the project). Never a command: the parent runs it after the child completes`,
					},
					model: { type: "string", minLength: 1, description: `a user-configured model profile (now: ${cfg.profiles.length ? cfg.profiles.map((x) => (typeof x === "string" ? x : x.name ?? x.id ?? JSON.stringify(x))).join(", ") : "none — omit model"})` },
					after: { type: "string", minLength: 1, description: "tester only: the earlier task (1-based index) whose worktree this tester runs in" },
					timeoutMs: { type: "integer", minimum: 1000, description: "wall-clock budget, ms" },
				},
				required: ["role", "task"],
				additionalProperties: false,
			},
		},
	},
	required: ["tasks"],
	additionalProperties: false,
});

export default async function createSubagentExtension() {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	if (depth >= 1) return { name: "subagent", tools: [] }; // depth guard — no nesting
	return {
		name: "subagent",
		tools: [
			{
				name: "delegate",
				description: "delegate tasks to child kiso agents: explorer, implementer, reviewer, tester",
				parameters: delegateParameters(delegationConfig()),
				execute: async (input, ctx) => {
					const tasks = ((input ?? {}).tasks ?? []).slice(0, 8);
					if (tasks.length === 0) return { content: "delegate: no tasks", isError: true, errorKind: "precondition" };
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
					// DT-1a: the artifact dir is PARENT-configured and stays under
					// KISO_HOME — never a per-task free path.
					const home = process.env.KISO_HOME ?? join(homedir(), ".kiso");
					const manifestDir = artifactDir(home, sessionsDir);
					if (manifestDir === null) return { content: "delegate: refused — KISO_SUBAGENT_ARTIFACTS must lie under KISO_HOME", isError: true, errorKind: "precondition" };
					mkdirSync(manifestDir, { recursive: true });
					// DT-1a: every task is validated BEFORE any child runs — a refusal
					// spawns nothing (acceptance never carries a model-supplied command).
					const cfg = delegationConfig();
					const parentCwd = process.cwd();
					for (let i = 0; i < tasks.length; i += 1) {
						const why = validateTask(tasks[i], cfg, parentCwd, manifestDir);
						// DT1a-F1 (owner dogfood 2026-09-08): a refusal BEFORE any child exists is a
						// precondition — nothing ran, nothing could have partially applied — so the
						// kernel must not append the non-idempotent "side effects may have partially
						// applied" banner (loop.ts keys that banner on errorKind !== "precondition")
						if (why !== null) return { content: `delegate: refused — task ${i + 1}: ${why}`, isError: true, errorKind: "precondition" };
					}
					const sections = await runLimited(tasks, CONCURRENCY, (task, i) =>
						runChild({
							childId: `sub-${parentId}-${delegationId}-${i + 1}-${task.role}`,
							manifestDir,
							manifest: { parentId, delegationId, index: i + 1, role: task.role, startedAt: Date.now() },
							role: task.role,
							task: task.task,
							scope: task.scope,
							acceptance: task.acceptance,
							model: task.model,
							after: task.after,
							cfg,
							sessionsDir,
							bin,
							timeout: task.timeoutMs ?? timeout,
							signal: ctx.signal,
							parentCwd,
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

async function runChild({ childId, role, task, scope, acceptance, model, after, cfg, sessionsDir, bin, timeout, signal, parentCwd, manifestDir, manifest }) {
	// CX-1 F6: the manifest binds this invocation to its child session
	// BEFORE anything runs — the durable record of "which run is mine".
	// DT-1a: the contract's inputs ride in it, verbatim.
	const startedAt = manifest?.startedAt ?? Date.now();
	if (manifestDir !== undefined) {
		writeFileSync(join(manifestDir, `${childId}.json`), `${JSON.stringify({ ...manifest, childId, task, ...(scope !== undefined ? { scope } : {}), ...(acceptance !== undefined ? { acceptance } : {}), ...(model !== undefined ? { model } : {}), ...(after !== undefined ? { after } : {}) })}\n`, "utf8");
	}
	// Isolation (DT-1a R2.2): implementer → its own detached worktree from
	// the parent's HEAD (the parent's UNCOMMITTED changes are not visible —
	// the section says so); tester → the implementer's kept worktree when
	// `after` names one, else a fresh worktree from HEAD; explorer and
	// reviewer → the parent's tree under a read-only policy. Non-git
	// parents fail the task HONESTLY.
	let worktree = null;
	let baseRev = null;
	let childCwd = parentCwd;
	let ownsWorktree = false;
	if (role === "tester" && after !== undefined) {
		const prior = readResultFile(manifestDir, after);
		worktree = prior.worktree;
		baseRev = prior.baseRev;
		childCwd = worktree;
	} else if (role === "implementer" || role === "tester") {
		worktree = mkdtempSync(join(tmpdir(), "kiso-subagent-wt-"));
		ownsWorktree = true;
		try {
			execFileSync("git", ["-C", parentCwd, "worktree", "add", "--detach", worktree], { stdio: "ignore" });
			// CX-1 F2: the base revision — a child that COMMITS is compared
			// against it, never read as "unchanged".
			baseRev = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
			childCwd = worktree;
		} catch (err) {
			rmSync(worktree, { recursive: true, force: true });
			return failSection(childId, role, task, `${role} needs a git repository: ${msg(err)}`);
		}
	}
	// The child-only role policy: one .mjs in its own temp extensions dir.
	// DT-1a R2.1: a scoped task's policy denies shell outright and checks
	// every write target against the globs after path normalization.
	const policyDir = mkdtempSync(join(tmpdir(), "kiso-subagent-policy-"));
	writeFileSync(join(policyDir, "policy.mjs"), rolePolicyContent(role, scope !== undefined ? { root: childCwd, globs: scope } : undefined), "utf8");
	let keepWorktree = false;
	try {
		// CX-1 F5 (audit F5): the task travels as a FILE the child reads into
		// exactly one user turn — never as stdin lines. DT-1a: it ends with
		// the fixed UNRESOLVED instruction the result parser reads back.
		const taskPath = join(manifestDir ?? policyDir, `${childId}.task`);
		writeFileSync(taskPath, `${task}\n\n${UNRESOLVED_INSTRUCTION}\n`, "utf8");
		const { code, stdout, killed } = await runProcess(childId, bin, childCwd, policyDir, taskPath, timeout, signal, model);
		const extraction = await extractChildResult(sessionsDir, childId, `exit ${code}\n${stdout}`);
		const status = killed === "timeout" ? "timeout" : killed === "abort" ? "killed" : code !== 0 && extraction.outcome === "missing" ? "spawn-failed" : extraction.outcome;
		let failed = code !== 0 || killed !== null || extraction.failed;
		const lines = [];
		if (killed === "timeout") {
			lines.push(`  FAILED: timed out after ${timeout}ms (the child process group was killed)`);
		} else if (killed === "abort") {
			lines.push("  FAILED: aborted by the parent run (the child process group was killed)");
		} else if (code !== 0) {
			lines.push(`  FAILED: the child exited with code ${code}\n${stdout}`);
		} else if (extraction.failed) {
			lines.push(`  FAILED: ${extraction.reason}${extraction.diag !== "" ? `\n${extraction.diag}` : ""}`);
		}
		const unresolved = parseUnresolved(extraction.text);
		// the collection (implementers only — a tester's worktree is the
		// implementer's or a throwaway; its changes are not its result)
		let changedFiles = null;
		let patchPath = null;
		let patchBytes = null;
		let collection = null;
		if (role === "implementer") {
			// CX-1 F2 (audit F2): tri-state collection. `collected` is earned
			// (the patch file closed AND git exited 0); a failure PRESERVES the
			// worktree and says so; "consumed" is undefined, so a worktree
			// with changes is always kept and named.
			patchPath = join(manifestDir ?? tmpdir(), `${childId}.patch`);
			collection = await collectWorktree(worktree, baseRev, patchPath);
			if (collection.kind === "collected") {
				keepWorktree = true;
				changedFiles = collection.changedFiles;
				patchBytes = collection.bytes;
			} else if (collection.kind === "failed") {
				keepWorktree = true;
				failed = true;
			} else {
				changedFiles = [];
				patchPath = null;
			}
		}
		// DT-1a R2.3: acceptance — the PARENT runs the named check or the
		// evaluator in the worktree, only after a COMPLETED child, with the
		// child's timeout, an output cap, and the parent's abort.
		let verification = null;
		if (acceptance !== undefined) {
			if (status !== "completed") verification = { skipped: status };
			else verification = await runAcceptance(acceptance, cfg, worktree ?? childCwd, baseRev, timeout, signal);
			if (verification.passed === false) failed = true;
		}
		const endedAt = Date.now();
		const result = {
			identity: { ...manifest, childId, role, startedAt, endedAt },
			status,
			task,
			...(scope !== undefined ? { scope } : {}),
			...(acceptance !== undefined ? { acceptance } : {}),
			...(model !== undefined ? { model } : {}),
			...(after !== undefined ? { after } : {}),
			worktree,
			baseRev,
			changedFiles,
			patchPath,
			patchBytes,
			verification,
			unresolved,
			answer: extraction.text,
			usage: extraction.usage,
			toolCalls: extraction.toolCalls,
			failed,
			diag: failed ? extraction.diag : "",
		};
		if (manifestDir !== undefined) writeFileSync(join(manifestDir, `${childId}.result.json`), `${JSON.stringify(result)}\n`, "utf8");
		// The section (what the model reads) — rendered from the result.
		const verdict = verification === null ? "none" : verification.skipped !== undefined ? `SKIPPED (${verification.skipped})` : verification.passed ? "PASSED" : "FAILED";
		let text = `[subagent] ${role}: ${task}\n  status: ${status} · verification: ${verdict}${changedFiles !== null ? ` · files changed: ${changedFiles.length}` : ""} · tools: ${extraction.toolCalls}`;
		if (scope !== undefined) text += `\n  scoped: no shell · writes only under ${scope.join(", ")}`;
		if (baseRev !== null) text += `\n  child saw HEAD ${baseRev.slice(0, 7)}; the parent's uncommitted changes were not visible`;
		if (verification !== null && verification.skipped === undefined) {
			text += `\n  verification: ${verification.kind} ${verification.passed ? "PASSED" : "FAILED"} · exit ${verification.exitCode === null ? "killed" : verification.exitCode} · ${verification.durationMs}ms · ${verification.kind === "check" ? verification.command : verification.evaluator}`;
			if (!verification.passed && verification.tail !== "") text += `\n${verification.tail}`;
		}
		for (const l of lines) text += `\n${l}`;
		if (extraction.text !== "") text += `\n${extraction.text}`;
		text += unresolved === null ? "\n  unresolved: not reported" : unresolved.length === 0 ? "\n  unresolved: none" : `\n  unresolved:\n${unresolved.map((u) => `  - ${u}`).join("\n")}`;
		if (collection !== null) {
			if (collection.kind === "collected") {
				text += `\n  diff:\n${collection.stat}\n  patch: ${patchPath}`;
				if (collection.bytes <= INLINE_PATCH_BYTES) text += `\n${readFileSync(patchPath, "utf8")}`;
				else text += `\n  (patch is ${collection.bytes} bytes — read it with the shell: cat ${patchPath}, or git -C ${worktree} diff ${baseRev})`;
				text += `\n  worktree kept at: ${worktree}`;
			} else if (collection.kind === "failed") {
				text += `\n  FAILED: collecting the worktree's changes: ${collection.reason}${collection.partialPath !== undefined ? ` (partial patch at ${collection.partialPath})` : ""}\n  worktree kept at: ${worktree}`;
			}
		}
		return { failed, text, toolCalls: extraction.toolCalls };
	} finally {
		rmSync(policyDir, { recursive: true, force: true });
		if (worktree !== null && ownsWorktree && !keepWorktree) removeWorktree(parentCwd, worktree);
	}
}

/** DT-1a: the fixed trailer every task file ends with — the parser reads the section back. */
export const UNRESOLVED_INSTRUCTION = 'When you finish, end your reply with a section titled UNRESOLVED listing what you could not do or verify, one item per line starting with "- ", or the single word none.';

/** DT-1a: what a delegated task may NAME — the parent CLI hands the configured
 *  checks and model profiles through the environment. Absent = nothing configured. */
function delegationConfig() {
	try {
		const raw = process.env.KISO_DELEGATION_CONFIG_JSON;
		const parsed = raw === undefined ? {} : JSON.parse(raw);
		return { checks: parsed.checks ?? {}, profiles: parsed.profiles ?? [] };
	} catch {
		return { checks: {}, profiles: [] };
	}
}

/** DT-1a: the artifact dir — the default under the sessions dir, or the
 *  parent-configured KISO_SUBAGENT_ARTIFACTS, which must lie under KISO_HOME. */
function artifactDir(home, sessionsDir) {
	const configured = process.env.KISO_SUBAGENT_ARTIFACTS;
	if (configured === undefined || configured === "") return join(sessionsDir, "subagent");
	const abs = resolve(configured);
	const homeAbs = resolve(home);
	return abs === homeAbs || abs.startsWith(homeAbs + sep) ? abs : null;
}

/** DT-1a: every task's inputs are judged BEFORE any child runs; a string is the refusal. */
export function validateTask(task, cfg, parentCwd, manifestDir) {
	if (task === null || typeof task !== "object") return "a task must be an object";
	if (!ROLES.includes(task.role)) return `unknown role ${JSON.stringify(task.role)}`;
	if (typeof task.task !== "string" || task.task.trim() === "") return "task must be a non-empty string";
	if (task.scope !== undefined) {
		if (!Array.isArray(task.scope) || task.scope.length === 0 || task.scope.some((g) => typeof g !== "string" || g === "" || isAbsolute(g) || g.split("/").includes(".."))) return "scope must be a non-empty list of relative globs (no absolute paths, no ..)";
		if (task.role !== "implementer" && task.role !== "tester") return "scope applies to implementer and tester tasks only";
	}
	if (task.acceptance !== undefined) {
		const a = task.acceptance;
		const keys = a !== null && typeof a === "object" ? Object.keys(a) : [];
		const one = keys.length === 1 && (keys[0] === "check" || keys[0] === "evaluator") && typeof a[keys[0]] === "string";
		if (!one) return "refused: acceptance must name a configured check ({ check }) or an evaluator path ({ evaluator }) — never a command";
		if (keys[0] === "check" && !Object.prototype.hasOwnProperty.call(cfg.checks, a.check)) return `refused: unknown check ${JSON.stringify(a.check)} (configured: ${Object.keys(cfg.checks).join(", ") || "none"})`;
		if (keys[0] === "evaluator") {
			if (!isAbsolute(a.evaluator) || !existsSync(a.evaluator)) return `refused: evaluator must be an existing absolute path: ${a.evaluator}`;
			const real = realpathSync(a.evaluator);
			const project = realpathSync(parentCwd);
			if (real === project || real.startsWith(project + sep)) return `refused: evaluator must live OUTSIDE the project (the child could reach it): ${a.evaluator}`;
		}
	}
	if (task.model !== undefined && !cfg.profiles.includes(task.model)) return `refused: unknown model profile ${JSON.stringify(task.model)} (configured: ${cfg.profiles.join(", ") || "none"})`;
	if (task.after !== undefined) {
		if (task.role !== "tester") return "refused: `after` is for tester tasks";
		let prior;
		try {
			prior = readResultFile(manifestDir, task.after);
		} catch (err) {
			return `refused: \`after\` names no completed implementer result: ${task.after} (${msg(err)})`;
		}
		if (prior.identity?.role !== "implementer" || prior.status !== "completed" || typeof prior.worktree !== "string" || !existsSync(prior.worktree)) return `refused: \`after\` must name a COMPLETED implementer whose worktree was kept: ${task.after}`;
	}
	if (task.timeoutMs !== undefined && (!Number.isInteger(task.timeoutMs) || task.timeoutMs < 1000)) return "timeoutMs must be an integer ≥ 1000";
	return null;
}

function readResultFile(manifestDir, childId) {
	if (!/^[A-Za-z0-9_-]+$/.test(childId)) throw new Error("not a child id");
	return JSON.parse(readFileSync(join(manifestDir, `${childId}.result.json`), "utf8"));
}

/** DT-1a: `**` crosses directories, `*` stays inside one, `?` is one char; everything else is literal. */
export function globToRegExp(glob) {
	let re = "^";
	for (let i = 0; i < glob.length; i += 1) {
		const c = glob[i];
		if (c === "*") {
			if (glob[i + 1] === "*") {
				re += ".*";
				i += 1;
				if (glob[i + 1] === "/") i += 1;
			} else re += "[^/]*";
		} else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`${re}$`);
}

/** DT-1a: is `target` (relative to `root`, or absolute) inside `root` AND under one of the globs —
 *  after `..` normalization and symlink resolution of the deepest existing ancestor? */
export function pathInScope(root, target, globs) {
	const rootReal = realpathSync(root);
	const abs = resolve(root, target);
	// resolve symlinks along the existing prefix, keep the rest verbatim
	let existing = abs;
	const rest = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) break;
		rest.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	let real;
	try {
		real = join(realpathSync(existing), ...rest);
	} catch {
		return false;
	}
	if (!(real === rootReal || real.startsWith(rootReal + sep))) return false;
	const rel = relative(rootReal, real).split(sep).join("/");
	return globs.some((g) => globToRegExp(g).test(rel));
}

/** DT-1a: the child's trailing UNRESOLVED section → items, [] for `none`, null when absent. */
export function parseUnresolved(text) {
	const m = /(?:^|\n)\s*(?:#+\s*)?UNRESOLVED\s*:?\s*\n([\s\S]*)$/i.exec(text ?? "");
	if (m === null) return null;
	const body = m[1].trim();
	if (body === "" || /^none\.?$/i.test(body)) return [];
	return body
		.split("\n")
		.map((l) => l.replace(/^\s*[-*•]\s*/, "").trim())
		.filter((l) => l !== "");
}

/** DT-1a: git's machine formats → explicit entries (renames as { from }, binaries as { binary }). */
export function parseChangedFiles(numstat, nameStatus) {
	const counts = new Map();
	for (const line of (numstat ?? "").split("\n")) {
		if (line.trim() === "") continue;
		const [a, r, ...pathParts] = line.split("\t");
		let path = pathParts.join("\t");
		const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
		if (brace !== null) path = `${brace[1]}${brace[3]}${brace[4]}`;
		else if (path.includes(" => ")) path = path.split(" => ").pop();
		counts.set(path, a === "-" ? null : { added: Number(a), removed: Number(r) });
	}
	const out = [];
	for (const line of (nameStatus ?? "").split("\n")) {
		if (line.trim() === "") continue;
		const parts = line.split("\t");
		const status = parts[0][0];
		const path = status === "R" || status === "C" ? parts[2] : parts[1];
		const c = counts.get(path);
		const entry = { path, status };
		if (status === "R" || status === "C") entry.from = parts[1];
		if (c === null) entry.binary = true;
		else if (c !== undefined) {
			entry.added = c.added;
			entry.removed = c.removed;
		}
		out.push(entry);
	}
	return out;
}

const ACCEPTANCE_OUTPUT_CAP = 64 * 1024;
const ACCEPTANCE_TAIL = 2 * 1024;

/** DT-1a R2.3: the parent runs the acceptance in the worktree — a configured check
 *  through /bin/sh (user-authored), or the evaluator binary with the worktree as
 *  its argument. Own process group (the abort and the timeout kill it whole), the
 *  output capped, the tail kept. The exit code proves the command RAN on the tree
 *  as the child left it (patchSha256 names that state); only an evaluator proves
 *  correctness — the child can edit a check's tests. */
export async function runAcceptance(acceptance, cfg, worktree, baseRev, timeout, signal) {
	const kind = acceptance.check !== undefined ? "check" : "evaluator";
	const command = kind === "check" ? cfg.checks[acceptance.check] : acceptance.evaluator;
	const started = Date.now();
	let patchSha256 = createHash("sha256").update("").digest("hex");
	try {
		execFileSync("git", ["-C", worktree, "add", "-N", "."], { stdio: "ignore" });
		const patch = execFileSync("git", ["-C", worktree, "diff", baseRev ?? "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
		patchSha256 = createHash("sha256").update(patch).digest("hex");
	} catch {
		// a non-git worktree: the state hash stays the empty one
	}
	const child = kind === "check" ? spawn("/bin/sh", ["-c", command], { cwd: worktree, detached: true, stdio: ["ignore", "pipe", "pipe"] }) : spawn(command, [worktree], { cwd: worktree, detached: true, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const capture = (d) => {
		if (output.length < ACCEPTANCE_OUTPUT_CAP) output += String(d).slice(0, ACCEPTANCE_OUTPUT_CAP - output.length);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
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
	const exitCode = await new Promise((resolveExit) => {
		child.on("error", () => resolveExit(null));
		child.on("exit", (code) => resolveExit(code));
	});
	clearTimeout(timer);
	signal?.removeEventListener("abort", onAbort);
	const code = killed !== null ? null : exitCode;
	return {
		kind,
		...(kind === "check" ? { name: acceptance.check, command } : { evaluator: command }),
		exitCode: code,
		passed: code === 0,
		...(killed !== null ? { killed } : {}),
		tail: output.slice(-ACCEPTANCE_TAIL),
		durationMs: Date.now() - started,
		patchSha256,
		baseRev,
	};
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
export function childArgs(bin, childId, taskPath, model) {
	// DT-1a: a configured profile name rides as the CLI's own --model flag
	// (the flag beats everything; the child shares the parent's config).
	return [bin, ...(model !== undefined ? ["--model", model] : []), "chat", childId, "--task-file", taskPath];
}

function runProcess(childId, bin, cwd, policyDir, taskPath, timeout, signal, model) {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const child = spawn(process.execPath, childArgs(bin, childId, taskPath, model), {
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
export function rolePolicyContent(role, scope) {
	const allowed = role === "implementer" || role === "tester" ? SIX_TOOLS : READ_ONLY;
	if (scope === undefined) {
		return `export default { name: "subagent-${role}", approvals: [{
	decide(call) {
		if (${JSON.stringify(allowed)}.includes(call.name)) return { action: "allow" };
		return { action: "deny", reason: "not allowed for the ${role} role" };
	}
}] };
`;
	}
	// DT-1a R2.1: a scoped task has NO shell (a shell writes anywhere; the
	// worktree is the only filesystem boundary a shell respects), and every
	// write target is checked after normalization — the helper is imported
	// from this very module by absolute URL, so the child runs the same code.
	const self = new URL(import.meta.url).href;
	return `import { pathInScope } from ${JSON.stringify(self)};
const ROOT = ${JSON.stringify(scope.root)};
const GLOBS = ${JSON.stringify(scope.globs)};
export default { name: "subagent-${role}-scoped", approvals: [{
	decide(call) {
		if (!${JSON.stringify(allowed)}.includes(call.name)) return { action: "deny", reason: "not allowed for the ${role} role" };
		if (call.name === "shell") return { action: "deny", reason: "scoped task: no shell (writes are limited to " + GLOBS.join(", ") + "; run the task unscoped for a shell)" };
		if (call.name === "write_file" || call.name === "edit_file") {
			const target = String((call.input && call.input.path) ?? "");
			if (!pathInScope(ROOT, target, GLOBS)) return { action: "deny", reason: "outside the task scope: " + target + " (allowed: " + GLOBS.join(", ") + ")" };
		}
		return { action: "allow" };
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
				return { outcome: "ambiguous", toolCalls: 0, text: "", usage: NO_USAGE, failed: true, reason: `child session ${childId} holds ${runIds.size} runs — the result cannot be located by identity`, diag };
			}
			events = records.map((r) => r.event ?? r);
		} catch (err) {
			lastErr = err;
			events = null;
		}
		if (events === null || !events.some((e) => e.type === "terminal")) await new Promise((r) => setTimeout(r, 200));
	}
	if (events === null) {
		return { outcome: "missing", toolCalls: 0, text: "", usage: NO_USAGE, failed: true, reason: `child session JSONL missing: ${msg(lastErr)}`, diag };
	}
	const terminal = events.find((e) => e.type === "terminal");
	if (terminal === undefined) {
		return { outcome: "no-terminal", toolCalls: countToolCalls(events), text: finalText(events), usage: usageOf(events), failed: true, reason: "child session has no terminal", diag };
	}
	const outcome = terminal.outcome?.kind ?? "unknown";
	const toolCalls = countToolCalls(events);
	const text = finalText(events);
	return {
		outcome,
		toolCalls,
		text,
		usage: usageOf(events),
		failed: outcome !== "completed",
		reason: outcome === "completed" ? "" : `child ended with ${outcome}`,
		diag: outcome === "completed" ? "" : diag,
	};
}

/** The canonical projection's void scope (core `project.ts`, the R-E 0.1.44
 *  sentence): a `model_output_abandoned` marker voids (voidFromSeq, seq] —
 *  the abandoned draft's events. A voided text_delta is not the child's
 *  answer and a voided tool_call_end never ran; both are skipped here
 *  exactly as the kernel skips them when it builds the next request. (The
 *  2026-09-07 review's P2: the old extractor glued a discarded draft onto
 *  the final answer and counted its calls — and reported success.) */
function committed(events) {
	const voids = events.filter((e) => e.type === "model_output_abandoned").map((e) => ({ from: e.voidFromSeq, to: e.seq }));
	return events.filter((e) => !voids.some((r) => e.seq > r.from && e.seq <= r.to));
}

function countToolCalls(events) {
	return committed(events).filter((e) => e.type === "tool_call_end").length;
}

const NO_USAGE = { completedResponses: null, abandonedAttempts: null, inputTokens: null, outputTokens: null, cacheRead: null };

/** DT-1a R2.4: the cost of the delegation, honestly — responses that carried a
 *  usage event (never a "requests" count: a failed request leaves none), the
 *  abandoned attempts counted separately, token sums over the former only. */
function usageOf(events) {
	const usages = committed(events).filter((e) => e.type === "usage");
	const sum = (k) => usages.reduce((n, e) => n + (typeof e[k] === "number" ? e[k] : 0), 0);
	return {
		completedResponses: usages.length,
		abandonedAttempts: events.filter((e) => e.type === "model_output_abandoned").length,
		inputTokens: sum("inputTokens"),
		outputTokens: sum("outputTokens"),
		cacheRead: sum("cacheRead"),
	};
}

/** Projection-equivalent: the assistant text since the last flush boundary,
 *  over the COMMITTED events only. */
function finalText(events) {
	let text = "";
	for (const e of committed(events)) {
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
		// DT-1a R2.4: the machine formats — never a parsed --stat
		var changedFiles = parseChangedFiles(
			execFileSync("git", ["-C", worktree, "diff", "--numstat", "-M", base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
			execFileSync("git", ["-C", worktree, "diff", "--name-status", "-M", base], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
		);
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
		return { kind: "collected", stat, bytes: statSync(patchPath).size, changedFiles };
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
