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
 *
 * ADR-0058 3d — background children: a host that passes its task manager
 * (`tasks`) gets `delegate({ …, background: true })`. Each child is then an
 * agent TASK — the same child kiso, launched by argv under the task runner,
 * so it outlives this process — and the call returns at once; the host's
 * delivery tells the model when the children have ended. Explorer and
 * reviewer only (D1), the whole batch within the session's cap or nothing
 * (D4), no timeoutMs (D5), and a turn budget instead of a deadline (D6).
 * Without `tasks` the schema and behaviour are exactly the foreground's.
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, closeSync, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

/** Default per-child timeout (ms) — a subagent must never hang the parent. */
const TIMEOUT_MS = 10 * 60 * 1000;
/** Max simultaneous children — the concurrency cap (mapLimited). */
const CONCURRENCY = 4;
/** ADR-0058 3d (D4): live background children per session, by default. */
const BACKGROUND_MAX = 20;
/** ADR-0058 3d (D6): a background child's model requests, by default — about
 *  twice the longest real explorer measured (17); 3f tunes it. */
const BACKGROUND_MAX_TURNS = 32;
/** 0.49.0 B: a writer's model requests, by default. The registered rule
 *  (ceil(1.25 x p95 of the probe's completed writers)) gave 12 on a
 *  one-function probe; the only real writers on record (41 and 66 requests)
 *  were both cut by the wall clock unfinished, so 12 would cut healthy work.
 *  128 is the kit's own fallback, above both; re-measured on a representative
 *  writer task in 0.50 (the owner's ruling, 2026-10-10). */
const WRITER_MAX_TURNS = 128;
/** ADR-0058 3d (D1): the roles whose unattended contract is defined. */

const SIX_TOOLS = ["read_file", "list_dir", "search_text", "write_file", "edit_file", "shell"];
const READ_ONLY = ["read_file", "list_dir", "search_text"];
// verifier: runs checks and reports evidence; its changes are never
// collected (ADR-0032 Amendment 1 — it was called tester until 0.46.0)
const ROLES = ["explorer", "implementer", "reviewer", "verifier"];
// 0.49.0 C2: a reader's turn budget, whether its parent waits or not. A
// writer has none until B measures one; it keeps the wall clock.
const READER_ROLES = ["explorer", "reviewer"];
// 0.49.0 A: how long a foreground reader delegation waits for its group —
// the shell's foreground wait (ADR-0058 §3, Amendment 10); the host's
// `joinMs` overrides it
const JOIN_MS = 60_000;
// 0.49.0 C3: what of a foreground child's printed output stays in memory —
// the rest is in its output.log, never in a string that grows with it.
const OUTPUT_TAIL_KEEP = 8 * 1024;

// DT1a-F2 (owner dogfood 2026-09-08): the model's first delegate call was
// refused twice — `scope` on an explorer, then an `acceptance` naming no
// configured check — because nothing in the schema said where scope applies
// or which checks exist. The field descriptions say so, and the configured
// check and profile names are written into the schema when the extension
// loads (the tool table is snapshotted per request — F7b — so this is the
// table the model reads).
// Plan B (the prefix diet): every field the model can use is listed, and
// none it cannot — `acceptance` only when the user configured a check or an
// evaluator, `model` only when a profile exists (an unconfigured field was a
// paragraph saying "omit this"). The descriptions name the contract once; the
// refusals in validateTask carry the detail when a call gets it wrong.
const delegateParameters = (cfg, background) => {
	const checks = Object.keys(cfg.checks);
	const profiles = cfg.profiles.map((x) => (typeof x === "string" ? x : x.name ?? x.id ?? JSON.stringify(x)));
	const acceptanceForms = [
		...(checks.length > 0 ? [`{ check: ${checks.join(" | ")} }`] : []),
		...(cfg.evaluators.length > 0 ? ["{ evaluator: a configured evaluator path }"] : []),
	];
	return {
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
						scope: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 32, description: "implementer/verifier only: globs the child may write (a scoped child has no shell)" },
						...(acceptanceForms.length > 0
							? {
									acceptance: {
										type: "object",
										properties: { check: { type: "string", minLength: 1 }, evaluator: { type: "string", minLength: 1 } },
										additionalProperties: false,
										description: `implementer/verifier only, one of ${acceptanceForms.join(" or ")} — never a command; run after the child completes`,
									},
								}
							: {}),
						...(profiles.length > 0 ? { model: { type: "string", minLength: 1, description: `a model profile: ${profiles.join(", ")}` } } : {}),
						after: { type: "string", minLength: 1, description: "verifier only: the 1-based index of the task whose worktree it checks" },
						// 0.49.0 A: with tasks wired, a child's bound is its turn budget and
						// the parent's is the join — no wall-clock kill to ask for
						...(background ? {} : { timeoutMs: { type: "integer", minimum: 1000, description: "the child's wall-clock budget, ms" } }),
					},
					required: ["role", "task"],
					additionalProperties: false,
				},
			},
			// ADR-0058 3d: present only when the host wired tasks — without them
			// the schema is byte-for-byte the foreground one. The description is
			// kept verbatim: "start the tasks" marks it as the CALL's flag. The
			// diet's shorter "run in the background" put it inside tasks[] in 4
			// of 5 smoke legs (0 of 5 with this text; plan-prefix-diet A10).
			// 0.49.0 B drops only the role limit ("explorer and reviewer only: ")
			// — writers run in the background too; the subagents kit counts
			// the schema refusals this wording could move (rc ≤ ctl + 2).
			...(background
				? {
						background: {
							type: "boolean",
							description:
								"start the tasks in the background and return at once; you are told when all of them have ended. They read the workspace as it is while they run; task_stop stops one",
						},
					}
				: {}),
		},
		required: ["tasks"],
		additionalProperties: false,
	};
};

/**
 * @param {{ tasks?: (sessionId: string | undefined) => any, backgroundMax?: number, backgroundMaxTurns?: number, currentBinding?: (sessionId: string | undefined) => ({ profile: string | null, model?: string, reasoning?: unknown } | null) }} [host]
 *   ADR-0058 3d: the host's per-session task manager (the runtime's
 *   TaskManager satisfies it structurally — no dependency), the cap on live
 *   background children per session, and a background child's turn budget.
 *   0.49.0 C1: the conversation's live binding — the profile its session is
 *   bound to and the effort it runs at — so a child that names no model
 *   runs on the conversation's, never on the config's default.
 */
export default async function createSubagentExtension(host = {}) {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	if (depth >= 1) return { name: "subagent", tools: [] }; // depth guard — no nesting
	const tasksOf = typeof host.tasks === "function" ? host.tasks : undefined;
	const background =
		tasksOf === undefined
			? undefined
			: {
					tasksOf,
					max: host.backgroundMax ?? BACKGROUND_MAX,
					maxTurns: host.backgroundMaxTurns ?? BACKGROUND_MAX_TURNS,
					// 0.49.0 B: writers — their cap, their turn budget (128: the
					// probe's 12 would cut real work), and the snapshot's size cap
					writerMax: host.writerMax ?? WRITER_MAX,
					writerMaxTurns: host.writerMaxTurns ?? WRITER_MAX_TURNS,
					snapshotMaxBytes: host.snapshotMaxBytes ?? SNAPSHOT_MAX_BYTES,
					reserved: new Map(),
				};
	// Plan B: ONE configuration snapshot per extension instance — the schema
	// the model is shown and the executor that validates its call read the
	// same values, so a session has one delegate contract (a config change
	// takes effect in the next session).
	const cfg = delegationConfig();
	return {
		name: "subagent",
		tools: [
			{
				name: "delegate",
				description:
					background !== undefined
						? "run subagent tasks (explorer/implementer/reviewer/verifier) in child kiso processes. Use background when the next step does not need the result; a foreground wait is bounded and continues in the background on its own."
						: "run subagent tasks (explorer/implementer/reviewer/verifier) in child kiso processes",
				parameters: delegateParameters(cfg, background !== undefined),
				promptSnippet: "delegate — run subagent tasks",
				execute: async (input, ctx) => {
					const tasks = ((input ?? {}).tasks ?? []).slice(0, 8);
					if (tasks.length === 0) return { content: "delegate: no tasks", isError: true, errorKind: "precondition" };
					const inBackground = (input ?? {}).background === true;
					if (inBackground && background === undefined) return { content: "delegate: background is not available here — run the delegation in the foreground", isError: true, errorKind: "precondition" };
					// 0.40.0: the parent's own folder (one per project), handed over
					// by the CLI; a pinned KISO_SESSIONS_DIR, or the legacy folder,
					// when no CLI said (a direct load)
					const sessionsDir = cfg.sessionsDir ?? (process.env.KISO_SESSIONS_DIR || join(process.env.KISO_HOME ?? join(homedir(), ".kiso"), "sessions"));
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
					const parentCwd = process.cwd();
					const binding = bindingOf(host, ctx.sessionId);
					for (let i = 0; i < tasks.length; i += 1) {
						const why = validateTask(tasks[i], cfg, parentCwd, manifestDir, { afterByIndex: background !== undefined });
						// DT1a-F1 (owner dogfood 2026-09-08): a refusal BEFORE any child exists is a
						// precondition — nothing ran, nothing could have partially applied — so the
						// kernel must not append the non-idempotent "side effects may have partially
						// applied" banner (loop.ts keys that banner on errorKind !== "precondition")
						if (why !== null) return { content: `delegate: refused — task ${i + 1}: ${why}`, isError: true, errorKind: "precondition" };
					}
					if (inBackground) return startBackground({ tasks, ctx, background, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding });
					// 0.49.0 A/B: with tasks wired, every delegation is a group of
					// agent tasks the call joins for up to joinMs — writers included
					if (background !== undefined) {
						return joinTasks({ tasks, ctx, background, joinMs: host.joinMs ?? JOIN_MS, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding });
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
							resolved: resolveChild(task, cfg, binding),
							maxTurns: READER_ROLES.includes(task.role) ? (host.backgroundMaxTurns ?? BACKGROUND_MAX_TURNS) : undefined,
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
					// the ONE-LINE shape the TUI's settled row renders verbatim.
					// The per-section text below is unchanged — the model's
					// view is preserved, the summary is additive.
					const summary = delegateSummary(sections, new Set(tasks.map((t) => t.role)).size);
					// C3: each child's handoff within 4 KiB, the call's within 16 KiB
					let budget = GROUP_HANDOFF_BYTES;
					const texts = sections.map((s) => {
						if (s.handoff === undefined) return s.text;
						// a failed acceptance's tail counts against its child's 4 KiB
						const reserved = Math.min(s.reserved ?? 0, budget);
						const body = handoffBody(s.handoff, Math.max(0, Math.min(CHILD_HANDOFF_BYTES, budget) - reserved));
						budget -= body.bytes + reserved;
						return `${s.text}${body.text}${s.trailer ?? ""}`;
					});
					return { content: `${summary}\n${texts.join("\n")}`, isError: sections.every((s) => s.failed) };
				},
			},
		],
	};
}

const refuse = (why) => ({ content: `delegate: refused — ${why}`, isError: true, errorKind: "precondition" });

/**
 * ADR-0058 3d — start the children as agent tasks and return at once.
 *
 * Everything up to the reservation is synchronous: the check that the
 * whole batch fits (live agent tasks + slots reserved by calls still
 * starting + this batch ≤ max) and the reservation are one step, so two
 * calls can never both fit into the last slots (D4). Each child's inputs —
 * its task file, role policy and manifest — are written and fsynced before
 * its task is planned (the runner and the child need nothing a `finally`
 * here could remove). The child is the same invocation a foreground child
 * runs, launched by argv (no shell), with its turn budget and its result
 * file beside its task (D6).
 */
async function startBackground({ tasks, ctx, background, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding }) {
	for (const task of tasks) {
		if (task.timeoutMs !== undefined) return refuse("timeoutMs applies to a foreground delegation; a background child has no wall-clock kill — task_stop stops one");
	}
	const r = await startTasks({ tasks, ctx, background, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding });
	if (r.refusal !== undefined) return r.refusal;
	const n = r.started.length;
	const writes = tasks.some((t) => WRITER_ROLES.includes(t.role));
	const content =
		`started ${n} background ${n === 1 ? "child" : "children"}: ${r.lines.join(", ")}. ` +
		(writes ? "Readers read the workspace as it is while they run; writers work in a snapshot of it taken now, and each one's patch is collected when it ends. " : "They read the workspace as it is while they run. ") +
		"You will be told when all of them have ended; task_stop stops one.";
	return { content, isError: n === 0 };
}

/** ADR-0058 3d — start a batch as agent tasks: the cap and the reservation
 *  as one step (D4), then each child's durable inputs and its launch, with
 *  its turn budget and its result file (D6). 0.49.0 A: the background call
 *  and the join share it. */
async function startTasks({ tasks, ctx, background, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding }) {
	const manager = background.tasksOf(ctx.sessionId);
	if (manager === undefined) return { refusal: refuse("background is not available here — run the delegation in the foreground") };
	const childIdOf = (i) => `sub-${parentId}-${delegationId}-${i + 1}-${tasks[i].role}`;
	// 0.49.0 B2: `after` names an implementer of THIS call by its 1-based
	// index; that implementer's collection hands it its tree and starts it
	const after = new Map();
	for (let i = 0; i < tasks.length; i += 1) {
		if (tasks[i].after === undefined) continue;
		const n = Number(tasks[i].after);
		if (tasks[i].role !== "verifier" || !Number.isInteger(n) || n < 1 || n > i || tasks[n - 1].role !== "implementer" || tasks[n - 1].after !== undefined) {
			return { refusal: refuse(`task ${i + 1}: \`after\` must give the 1-based index of an earlier implementer in this call — its tree is collected and handed to the verifier; an earlier call's implementer has no tree left to hand over`) };
		}
		after.set(i, n - 1);
	}
	const key = ctx.sessionId ?? "";
	const live = manager.list().filter((t) => t.agent !== undefined && t.state.kind !== "not_run" && (t.state.kind !== "ended" || (t.agent.collect === true && t.collection === undefined))).length + (background.reserved.get(key) ?? 0);
	if (live + tasks.length > background.max) {
		return { refusal: refuse(`${live} background children are running in this session and the cap is ${background.max}; this call asks for ${tasks.length}. Do not retry — wait for some to end, or stop one with task_stop`) };
	}
	// B4: a writer holds a workspace and runs commands — its own cap
	const writers = tasks.filter((t) => WRITER_ROLES.includes(t.role)).length;
	const liveWriters = manager.list().filter((t) => t.agent?.collect === true && t.state.kind !== "not_run" && (t.state.kind !== "ended" || t.collection === undefined)).length;
	if (writers > 0 && liveWriters + writers > background.writerMax) {
		return { refusal: refuse(`${liveWriters} writers (implementer or verifier) are running in this session and the writer cap is ${background.writerMax}; this call asks for ${writers}. Do not retry — wait for some to end, or stop one with task_stop`) };
	}
	background.reserved.set(key, (background.reserved.get(key) ?? 0) + tasks.length);
	let unstarted = tasks.length;
	const release = (n) => background.reserved.set(key, Math.max(0, (background.reserved.get(key) ?? 0) - n));
	const lines = [];
	const started = [];
	const failed = [];
	const pending = [];
	try {
		// B6.1: every writer that starts now gets its snapshot FIRST — all or
		// nothing: a refusal (the cap, a moving tree, no repository) starts no child
		const spaces = new Map();
		for (let i = 0; i < tasks.length; i += 1) {
			if (!WRITER_ROLES.includes(tasks[i].role) || after.has(i)) continue;
			try {
				spaces.set(i, snapshotWorkspace(process.cwd(), join(manifestDir, childIdOf(i), "ws"), background.snapshotMaxBytes));
			} catch (err) {
				for (const j of spaces.keys()) rmSync(join(manifestDir, childIdOf(j), "ws"), { recursive: true, force: true });
				return { refusal: refuse(err instanceof SnapshotRefusal ? err.message : `a writer's workspace could not be built: ${msg(err)}`) };
			}
		}
		for (let i = 0; i < tasks.length; i += 1) {
			const task = tasks[i];
			const childId = childIdOf(i);
			const writer = WRITER_ROLES.includes(task.role);
			const maxTurns = writer ? background.writerMaxTurns : background.maxTurns;
			try {
				const resolved = resolveChild(task, cfg, binding);
				const manifest = { parentId, delegationId, index: i + 1, role: task.role, startedAt: Date.now(), ...modelFieldsOf(resolved), ...(maxTurns !== undefined ? { maxTurns } : {}) };
				if (after.has(i)) {
					// durable now, started by its implementer's collection
					writeChildInputs(manifestDir, childId, task, { ...manifest, after: after.get(i) + 1, deferred: true });
					pending.push({ index: i, task, childId, behind: after.get(i) });
					continue;
				}
				const space = spaces.get(i);
				const dependents = [...after].filter(([, j]) => j === i).map(([v]) => ({ childId: childIdOf(v) }));
				const inputs = writeChildInputs(
					manifestDir,
					childId,
					task,
					{ ...manifest, ...(space !== undefined ? { workspace: join(manifestDir, childId, "ws"), base: space.base, head: space.head, sub: space.sub, dependents } : {}) },
					space?.cwd,
				);
				const info = await manager.start({
					command: `${task.role}: ${task.task.split("\n")[0].slice(0, 80)}`,
					cwd: space?.cwd ?? process.cwd(),
					env: childEnv(inputs.policyDir, sessionsDir, resolved.reasoning),
					...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}),
					agent: writer ? { role: task.role, session: childId, collect: true } : { role: task.role, session: childId },
					exec: (dir) => ({ file: process.execPath, args: [...childArgs(bin, childId, inputs.taskPath, resolved.profile), ...(maxTurns !== undefined ? ["--max-turns", String(maxTurns)] : []), "--result-file", join(dir, "result.md")] }),
				});
				lines.push(`${info.id} ${task.role} (session ${childId})`);
				started.push({ id: info.id, task, childId, resolved });
			} catch (err) {
				lines.push(`task ${i + 1} (${task.role}) did not start: ${msg(err)}`);
				failed.push({ task, why: msg(err) });
			}
			unstarted -= 1;
			release(1);
		}
	} finally {
		release(unstarted);
	}
	for (const p of pending) {
		const host = started.find((s) => s.childId === childIdOf(p.behind));
		lines.push(`task ${p.index + 1} verifier starts once ${host !== undefined ? host.id : `task ${p.behind + 1}`} is collected`);
	}
	return { manager, started, failed, pending, lines };
}

/** 0.49.0 A — the join: a reader delegation is a group of agent tasks
 *  from its start, and the call waits for them up to `joinMs` — the
 *  shell's foreground wait (ADR-0058 Amendment 10), reused. What ended
 *  while it waited is CLAIMED by this call (its result reports it, I2);
 *  what is still running continues as the group, whose notice wakes the
 *  parent. Nothing is killed: the budget, the person's key (detach), a
 *  steer and Esc all end the WAIT, never a child. */
async function joinTasks({ tasks, ctx, background, joinMs, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding }) {
	const r = await startTasks({ tasks, ctx, background, sessionsDir, parentId, bin, delegationId, manifestDir, cfg, binding });
	if (r.refusal !== undefined) return r.refusal;
	const { manager, started, failed, pending } = r;
	const release = new AbortController();
	let reason = null;
	const onEsc = () => {
		reason ??= "interrupted";
		release.abort();
	};
	if (ctx.signal?.aborted) onEsc();
	else ctx.signal?.addEventListener?.("abort", onEsc);
	const undetach =
		typeof manager.registerDetachable === "function" && ctx.executionId !== undefined
			? manager.registerDetachable(ctx.executionId, {
					startedAt: Date.now(),
					detach: (by) => {
						reason ??= by;
						release.abort();
					},
				})
			: () => {};
	let settled;
	try {
		settled = await Promise.all(started.map((s) => manager.awaitSettled(s.id, "end", joinMs, { ...(ctx.executionId !== undefined ? { executionId: ctx.executionId } : {}), signal: release.signal, agentJoin: true })));
	} finally {
		undetach();
		ctx.signal?.removeEventListener?.("abort", onEsc);
	}
	const sections = [];
	const deferred = [];
	const running = [];
	// B2: a verifier its implementer's collection started is in the group too
	const known = new Set(started.map((s) => s.id));
	const late = manager.list().filter((t) => t.agent !== undefined && t.executionId === ctx.executionId && !known.has(t.id));
	started.forEach((s, i) => {
		const w = settled[i];
		if (w.settled && w.claimed) sections.push(memberSection(s, w.info));
		else if (w.settled) deferred.push(s);
		else running.push(s);
	});
	for (const f of failed) sections.push({ failed: true, failKind: "error", text: `[subagent] ${f.task.role}: ${f.task.task}\n  FAILED: did not start: ${f.why}`, toolCalls: 0 });
	const summary = delegateSummary([...sections, ...[...deferred, ...running].map(() => ({ failed: false, toolCalls: 0 }))], new Set(tasks.map((t) => t.role)).size);
	let budget = GROUP_HANDOFF_BYTES;
	const texts = sections.map((sec) => {
		if (sec.handoff === undefined) return sec.text;
		const body = handoffBody(sec.handoff, Math.min(CHILD_HANDOFF_BYTES, budget));
		budget -= body.bytes;
		return `${sec.text}${body.text}${sec.trailer ?? ""}`;
	});
	// I2: an end this call could not claim is the group's to deliver
	for (const d of deferred) texts.push(`[subagent] ${d.task.role}: ${d.task.task}\n  ended as task ${d.id} — its result follows in the group's notice`);
	const waiting = pending.filter((p) => !late.some((t) => t.agent?.session === p.childId));
	if (running.length > 0) {
		const why = reason === null ? `still running after ${joinMs} ms` : reason === "person" ? "moved to the background by the person" : reason === "steer" ? "moved to the background so the person's message could land" : "interrupted";
		const ids = running.map((s) => s.id);
		texts.push(`${why}: continued as background ${ids.length === 1 ? "task" : "tasks"} ${ids.join(", ")}; you will be told when all of them have ended; task_stop stops one.`);
	}
	// B2: a verifier its implementer's collection started — not a wait cut short
	if (late.length > 0) {
		const ids = late.map((t) => t.id);
		texts.push(`started by its implementer's collection: background ${ids.length === 1 ? "task" : "tasks"} ${ids.join(", ")}; you will be told when all of them have ended; task_stop stops one.`);
	}
	for (const p of waiting) texts.push(`[subagent] verifier: ${p.task.task}\n  starts once task ${p.behind + 1}'s implementer is collected, in its tree (base plus its patch); its result follows in the group's notice`);
	const isError = running.length === 0 && late.length === 0 && waiting.length === 0 && deferred.length === 0 && sections.length > 0 && sections.every((sec) => sec.failed);
	return { content: `${summary}\n${texts.join("\n")}`, isError };
}

/** 0.49.0 A — a joined child's section, from its task directory: the
 *  same head and handoff a foreground child's has (C3), read from its
 *  result record (I5/I6) and its output. */
function memberSection(s, info) {
	const dir = dirname(info.outputPath);
	const { record, full, answer } = readChildResult(dir);
	const exitCode = info.state?.kind === "ended" ? info.state.exitCode : null;
	const status = record !== null ? record.outcome : "failed";
	const failed = record === null || record.outcome === "failed";
	const toolCalls = typeof full?.toolCalls === "number" ? full.toolCalls : 0;
	const ranOn = typeof full?.profile === "string" ? full.profile : typeof full?.model === "string" ? full.model : (s.resolved.profile ?? "unknown");
	let text = `[subagent] ${s.task.role}: ${s.task.task}\n  status: ${status} · model: ${ranOn}${s.resolved.source === "environment" ? " (default)" : ""} · verification: none · tools: ${toolCalls} · task ${s.id}`;
	if (record === null) text += `\n  FAILED: the child ${exitCode !== null && exitCode !== 0 ? `exited with code ${exitCode} and ` : ""}left no result record`;
	else if (record.outcome === "failed") text += `\n  FAILED: the child's run ended with ${typeof full?.endedBy === "string" ? full.endedBy : "a failure"}`;
	const tail = rawTail(info.outputPath, HANDOFF_TAIL_BYTES);
	const unresolved = record === null ? null : parseUnresolved(answer);
	let trailer = unresolved === null && record !== null && answer.trim() !== "" ? "\n  unresolved: not reported" : "";
	let writerFailed = false;
	if (s.task.role === "implementer") {
		const w = writerLines(dir, info);
		trailer += w.text;
		writerFailed = w.failed;
	}
	const all = failed || writerFailed;
	return { failed: all, ...(all ? { failKind: "error" } : {}), text, handoff: { record, answer, tail: tail.text, tailCut: tail.cut, resultPath: join(dir, "result.md") }, trailer, toolCalls };
}

/** B — what an implementer's handoff adds: its patch (by path, never
 *  inline), the base it was written against, the child's acceptance, the
 *  command that adopts it, and what became of a verifier behind it. */
function writerLines(dir, info) {
	const c = info.collection;
	if (c?.outcome === "failed") return { text: `\n  FAILED: collecting its changes: ${c.reason ?? "unknown"}`, failed: true };
	let patch = null;
	try {
		patch = JSON.parse(readFileSync(join(dir, "patch.json"), "utf8"));
	} catch {
		return { text: "\n  FAILED: its patch record is missing", failed: true };
	}
	if (patch.files.length === 0) return { text: "\n  no changes", failed: false };
	let acc = "none";
	try {
		const v = JSON.parse(readFileSync(join(dir, "acceptance.json"), "utf8"));
		acc = v.passed ? "PASSED" : "FAILED";
	} catch {
		// no acceptance named, or the child did not complete
	}
	const files = patch.files.map((f) => f.path);
	const bin = process.env.KISO_SUBAGENT_BIN ?? process.argv[1];
	let text = `\n  patch: ${join(dir, "patch.diff")} (${files.length} ${files.length === 1 ? "file" : "files"}: ${files.slice(0, 8).join(", ")}${files.length > 8 ? ", …" : ""}) · base ${String(patch.base).slice(0, 7)} · child acceptance: ${acc}`;
	text += patch.applyable ? `\n  apply: node ${shellQuote(bin)} apply-patch ${shellQuote(dir)}` : `\n  the child was stopped: the patch is partial — apply only with: node ${shellQuote(bin)} apply-patch ${shellQuote(dir)} --allow-partial`;
	try {
		const deps = JSON.parse(readFileSync(join(dir, "dependents.json"), "utf8"));
		for (const d of Object.values(deps)) text += d.taskId !== undefined ? `\n  its verifier runs as task ${d.taskId}, in base plus this patch` : `\n  its verifier was skipped: ${d.skipped}`;
	} catch {
		// no verifier behind it
	}
	return { text, failed: acc === "FAILED" };
}

/** A path for the shell: single-quoted when it needs quoting. */
function shellQuote(p) {
	return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${String(p).replaceAll("'", "'\\''")}'`;
}

/** The durable inputs of a background child: the task file (the fixed
 *  UNRESOLVED trailer included), its role policy, its manifest — fsynced
 *  with their directories before the task is planned. */
function writeChildInputs(manifestDir, childId, task, manifest, policyRoot) {
	const taskPath = join(manifestDir, `${childId}.task`);
	const policyDir = join(manifestDir, `${childId}.policy`);
	mkdirSync(policyDir, { recursive: true });
	// DT-1a R2.1: a scoped writer's policy checks every write against its globs, from its own root
	writeDurable(join(policyDir, "policy.mjs"), rolePolicyContent(task.role, task.scope !== undefined && policyRoot !== undefined ? { root: policyRoot, globs: task.scope } : undefined));
	writeDurable(taskPath, `${task.task}\n\n${UNRESOLVED_INSTRUCTION}\n`);
	writeDurable(join(manifestDir, `${childId}.json`), `${JSON.stringify({ ...manifest, childId, task: task.task, background: true, ...(task.scope !== undefined ? { scope: task.scope } : {}), ...(task.acceptance !== undefined ? { acceptance: task.acceptance } : {}) })}\n`);
	fsyncPath(policyDir);
	fsyncPath(manifestDir);
	return { taskPath, policyDir };
}

function writeDurable(path, content) {
	const fd = openSync(path, "w");
	try {
		writeSync(fd, content);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function fsyncPath(dir) {
	const fd = openSync(dir, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
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

async function runChild({ childId, role, task, scope, acceptance, resolved, maxTurns, after, cfg, sessionsDir, bin, timeout, signal, parentCwd, manifestDir, manifest }) {
	// CX-1 F6: the manifest binds this invocation to its child session
	// BEFORE anything runs — the durable record of "which run is mine".
	// DT-1a: the contract's inputs ride in it, verbatim.
	const startedAt = manifest?.startedAt ?? Date.now();
	if (manifestDir !== undefined) {
		writeFileSync(join(manifestDir, `${childId}.json`), `${JSON.stringify({ ...manifest, childId, task, ...(scope !== undefined ? { scope } : {}), ...(acceptance !== undefined ? { acceptance } : {}), ...modelFieldsOf(resolved), ...(after !== undefined ? { after } : {}) })}\n`, "utf8");
	}
	// Isolation (DT-1a R2.2): implementer → its own detached worktree from
	// the parent's HEAD (the parent's UNCOMMITTED changes are not visible —
	// the section says so); verifier → a COPY of the implementer's kept
	// worktree when `after` names one (a fresh worktree at the same base
	// with the implementer's changes applied — the kept worktree the
	// parent was handed is never touched), else a fresh worktree from HEAD;
	// explorer and reviewer → the parent's tree under a read-only policy.
	// Non-git parents fail the task HONESTLY.
	let worktree = null;
	let baseRev = null;
	let childCwd = parentCwd;
	let ownsWorktree = false;
	if (role === "verifier" && after !== undefined) {
		const prior = readResultFile(manifestDir, after);
		baseRev = prior.baseRev;
		worktree = mkdtempSync(join(tmpdir(), "kiso-subagent-wt-"));
		ownsWorktree = true;
		try {
			execFileSync("git", ["-C", parentCwd, "worktree", "add", "--detach", worktree, baseRev ?? "HEAD"], { stdio: "ignore" });
			// the implementer's state against its base — committed or not,
			// new files included (intent-to-add), binary-safe
			execFileSync("git", ["-C", prior.worktree, "add", "-N", "."], { stdio: "ignore" });
			const patch = execFileSync("git", ["-C", prior.worktree, "diff", "--binary", baseRev ?? "HEAD"], { maxBuffer: 256 * 1024 * 1024 });
			if (patch.length > 0) execFileSync("git", ["-C", worktree, "apply", "--binary", "--whitespace=nowarn"], { input: patch, stdio: ["pipe", "ignore", "pipe"] });
			childCwd = worktree;
		} catch (err) {
			removeWorktree(parentCwd, worktree);
			return failSection(childId, role, task, `the verifier could not copy the implementer's worktree: ${msg(err)}`);
		}
	} else if (role === "implementer" || role === "verifier") {
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
		// 0.49.0 C2/C3: the child's own directory — its result record, its
		// answer and its printed output, as a background child's task has
		const childDir = join(manifestDir ?? tmpdir(), childId);
		mkdirSync(childDir, { recursive: true });
		const { code, killed, unconfirmed, outputPath } = await runProcess({ childId, bin, cwd: childCwd, policyDir, taskPath, timeout, signal, resolved, sessionsDir, childDir, maxTurns });
		// I5/I6: the result is what the child's record commits — never
		// inferred from its printed output or from its session's runs
		const { record, full, answer } = readChildResult(childDir);
		const status = killed === "timeout" ? "timeout" : killed === "abort" ? "killed" : record !== null ? record.outcome : code !== 0 ? "failed" : "no-result";
		let failed = code !== 0 || killed !== null || record === null || record.outcome === "failed";
		const toolCalls = typeof full?.toolCalls === "number" ? full.toolCalls : 0;
		const lines = [];
		// Windows P6: a kill that did not take is never reported as a kill
		const killNote = unconfirmed.length > 0 ? ` — could not confirm the child exited (pid ${unconfirmed.join(", ")}): treat its side effects as UNCERTAIN` : " (the child process group was killed)";
		if (killed === "timeout") {
			lines.push(`  FAILED: timed out after ${timeout}ms${killNote}`);
		} else if (killed === "abort") {
			lines.push(`  FAILED: aborted by the parent run${killNote}`);
		} else if (record === null) {
			lines.push(`  FAILED: the child ${code !== 0 ? `exited with code ${code} and ` : ""}left no result record`);
		} else if (record.outcome === "failed") {
			lines.push(`  FAILED: the child's run ended with ${typeof full?.endedBy === "string" ? full.endedBy : "a failure"}`);
		}
		const unresolved = record === null ? null : parseUnresolved(answer);
		// the collection (implementers only — a verifier's worktree is a
		// throwaway copy; its changes are not its result)
		let changedFiles = null;
		let patchPath = null;
		let patchBytes = null;
		let collection = null;
		// Windows P6: a child that may still be running keeps its worktree,
		// and nothing is collected from it — a patch of a tree that may
		// still change is not the child's result
		if (unconfirmed.length > 0 && worktree !== null) keepWorktree = true;
		if (role === "implementer" && unconfirmed.length === 0) {
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
		const tail = rawTail(outputPath, HANDOFF_TAIL_BYTES);
		const endedAt = Date.now();
		const result = {
			identity: { ...manifest, childId, role, startedAt, endedAt },
			status,
			task,
			...(scope !== undefined ? { scope } : {}),
			...(acceptance !== undefined ? { acceptance } : {}),
			...modelFieldsOf(resolved),
			...(after !== undefined ? { after } : {}),
			worktree,
			baseRev,
			changedFiles,
			patchPath,
			patchBytes,
			verification,
			...(unconfirmed.length > 0 ? { unconfirmed } : {}),
			unresolved,
			answer: record === null ? "" : answer.trimEnd(),
			usage: full?.usage ?? NO_USAGE,
			toolCalls,
			failed,
			diag: failed ? tail.text : "",
			childDir,
		};
		if (manifestDir !== undefined) writeFileSync(join(manifestDir, `${childId}.result.json`), `${JSON.stringify(result)}\n`, "utf8");
		// The section (what the model reads) — its head, then the child's
		// handoff (C3: the shared format, within the call's budget), then
		// what only a writer has.
		const verdict = verification === null ? "none" : verification.skipped !== undefined ? `SKIPPED (${verification.skipped})` : verification.passed ? "PASSED" : "FAILED";
		const ranOn = typeof full?.profile === "string" ? full.profile : typeof full?.model === "string" ? full.model : (resolved.profile ?? "unknown");
		let text = `[subagent] ${role}: ${task}\n  status: ${status} · model: ${ranOn}${resolved.source === "environment" ? " (default)" : ""} · verification: ${verdict}${changedFiles !== null ? ` · files changed: ${changedFiles.length}` : ""} · tools: ${toolCalls}`;
		if (scope !== undefined) text += `\n  scoped: no shell · writes only under ${scope.join(", ")}`;
		if (baseRev !== null) text += `\n  child saw HEAD ${baseRev.slice(0, 7)}; the parent's uncommitted changes were not visible`;
		let reserved = 0;
		if (verification !== null && verification.skipped === undefined) {
			const exit = verification.unconfirmed !== undefined ? `killed, not confirmed (pid ${verification.unconfirmed.join(", ")} may still be running — treat its side effects as UNCERTAIN)` : verification.exitCode === null ? "killed" : verification.exitCode;
			text += `\n  verification: ${verification.kind} ${verification.passed ? "PASSED" : "FAILED"} · exit ${exit} · ${verification.durationMs}ms · ${verification.kind === "check" ? verification.command : verification.evaluator}`;
			if (!verification.passed && verification.tail !== "") {
				text += `\n${verification.tail}`;
				reserved = Buffer.byteLength(verification.tail);
			}
		}
		for (const l of lines) text += `\n${l}`;
		let trailer = "";
		if (unresolved === null && record !== null && answer.trim() !== "") trailer += "\n  unresolved: not reported";
		if (collection !== null) {
			if (collection.kind === "collected") {
				trailer += `\n  diff:\n${collection.stat}\n  patch: ${patchPath}\n  worktree kept at: ${worktree}`;
			} else if (collection.kind === "failed") {
				trailer += `\n  FAILED: collecting the worktree's changes: ${collection.reason}${collection.partialPath !== undefined ? ` (partial patch at ${collection.partialPath})` : ""}\n  worktree kept at: ${worktree}`;
			}
		} else if (unconfirmed.length > 0 && worktree !== null) {
			trailer += `\n  worktree kept at: ${worktree} — the child may still be writing to it; nothing was collected`;
		}
		const handoff = { record, answer, tail: tail.text, tailCut: tail.cut, resultPath: join(childDir, "result.md") };
		return { failed, ...(failed ? { failKind: failKindOf(status, verification) } : {}), text, handoff, reserved, trailer, toolCalls };
	} finally {
		rmSync(policyDir, { recursive: true, force: true });
		if (worktree !== null && ownsWorktree && !keepWorktree) removeWorktree(parentCwd, worktree);
	}
}

/** 0.40.0 — why a child failed, in the three words a person acts on: its
 *  clock ran out (`timeout`: raise it, or split the task), the parent's
 *  acceptance check RAN and failed (`acceptance`: the work is wrong), or
 *  anything else (`error`: a crash, an abort, a missing or ambiguous
 *  result, a spawn or collection failure — read the report). */
export function failKindOf(status, verification) {
	if (status === "timeout") return "timeout";
	if (verification !== null && verification !== undefined && verification.passed === false) return "acceptance";
	return "error";
}

const FAIL_KIND_ORDER = ["timeout", "acceptance", "error"];

/** 0.40.0 — the settled row's marker: how many tasks ran, and — when any
 *  failed — how many of each kind, in a fixed order with zero counts
 *  omitted. A failed section without a kind counts as an error: a failure
 *  is never silently left out of the count. */
export function delegateSummary(sections, roles) {
	const n = sections.length;
	const toolCalls = sections.reduce((sum, s) => sum + (s.toolCalls ?? 0), 0);
	const failedSections = sections.filter((s) => s.failed);
	const counts = new Map(FAIL_KIND_ORDER.map((k) => [k, 0]));
	for (const s of failedSections) {
		const k = FAIL_KIND_ORDER.includes(s.failKind) ? s.failKind : "error";
		counts.set(k, counts.get(k) + 1);
	}
	const kinds = FAIL_KIND_ORDER.filter((k) => counts.get(k) > 0).map((k) => `${counts.get(k)} ${k}`);
	return `summary: ${n} task${n === 1 ? "" : "s"} · ${toolCalls} tool calls · ${roles} role${roles === 1 ? "" : "s"} · ${failedSections.length} failed${kinds.length > 0 ? ` (${kinds.join(", ")})` : ""}`;
}

/** DT-1a: the fixed trailer every task file ends with — the parser reads
 *  the section back. 0.49.0 C3: it states the handoff contract too — the
 *  child's final answer is all the parent reads of its run. */
export const UNRESOLVED_INSTRUCTION =
	'Your final answer is a handoff to the parent: the conclusion first, only the evidence needed to act on it, no raw command output or large diffs. End it with a section titled UNRESOLVED listing what you could not do or verify, one item per line starting with "- ", or the single word none.';

/** DT-1a: what a delegated task may NAME — the parent CLI hands the configured
 *  checks and model profiles through the environment. Absent = nothing configured. */
function delegationConfig() {
	try {
		const raw = process.env.KISO_DELEGATION_CONFIG_JSON;
		const parsed = raw === undefined ? {} : JSON.parse(raw);
		return {
			checks: parsed.checks ?? {},
			evaluators: Array.isArray(parsed.evaluators) ? parsed.evaluators.filter((p) => typeof p === "string") : [],
			profiles: parsed.profiles ?? [],
			sessionsDir: typeof parsed.sessionsDir === "string" && parsed.sessionsDir !== "" ? parsed.sessionsDir : undefined,
			// 0.49.0 C1: the user's subagents.model (validated by the host)
			subagentsModel: typeof parsed.subagentsModel === "string" && parsed.subagentsModel !== "" ? parsed.subagentsModel : undefined,
		};
	} catch {
		return { checks: {}, evaluators: [], profiles: [], sessionsDir: undefined, subagentsModel: undefined };
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
export function validateTask(task, cfg, parentCwd, manifestDir, opts = {}) {
	if (task === null || typeof task !== "object") return "a task must be an object";
	if (task.role === "tester") return 'unknown role "tester" — it is called "verifier" since 0.46.0';
	if (!ROLES.includes(task.role)) return `unknown role ${JSON.stringify(task.role)}`;
	if (typeof task.task !== "string" || task.task.trim() === "") return "task must be a non-empty string";
	if (task.scope !== undefined) {
		if (!Array.isArray(task.scope) || task.scope.length === 0 || task.scope.some((g) => typeof g !== "string" || g === "" || isAbsolute(g) || g.split("/").includes(".."))) return "scope must be a non-empty list of relative globs (no absolute paths, no ..)";
		if (task.role !== "implementer" && task.role !== "verifier") return "scope applies to implementer and verifier tasks only";
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
			// CS-1 (0.40.7): only a script the USER listed. The model chooses
			// the task, so an unlisted path could be an interpreter
			// (`/usr/bin/python3 <worktree>`) running code the child wrote —
			// outside the shell tool and everything that reads shell lines.
			const listed = (cfg.evaluators ?? []).some((p) => {
				try {
					return realpathSync(p) === real;
				} catch {
					return false;
				}
			});
			if (!listed) return `refused: ${a.evaluator} is not a configured evaluator — the user lists evaluator scripts in "evaluators" in the kiso config (configured: ${(cfg.evaluators ?? []).join(", ") || "none"}); use a configured check instead, or omit acceptance`;
		}
	}
	if (task.model !== undefined && !cfg.profiles.includes(task.model)) return `refused: unknown model profile ${JSON.stringify(task.model)} (configured: ${cfg.profiles.join(", ") || "none"})`;
	// 0.49.0 B2: with tasks wired, `after` is an index into this call — the
	// batch checks it (startTasks); an earlier call's tree no longer exists
	if (task.after !== undefined && opts.afterByIndex === true) {
		if (task.role !== "verifier") return "refused: `after` is for verifier tasks";
	} else if (task.after !== undefined) {
		if (task.role !== "verifier") return "refused: `after` is for verifier tasks";
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

/** A child in its own process group, so a timeout or an abort kills it
 *  whole; win32 has no groups — the child is hidden, and its tree dies by
 *  taskkill /T (which walks it by parent). */
const ownGroup = () => (process.platform === "win32" ? { windowsHide: true } : { detached: true });

function killGroup(child) {
	try {
		if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		// already gone, or the kill was refused: the bounded wait decides
	}
}

/** How long the wait after a kill lasts before the child's exit is
 *  declared unconfirmed — tools-node's killTree uses the same fallback. */
const KILL_CONFIRM_MS = 2_000;

/** The child's exit, supervised: the timeout and the parent's abort kill
 *  its group, and the wait after a kill is bounded (Windows P6). A kill
 *  that does not take — taskkill refused, a group SIGKILL refused with
 *  EPERM — leaves the child running; after KILL_CONFIRM_MS its pid comes
 *  back in `unconfirmed` (tools-node's contract: the caller must not
 *  report it gone) and the child is let go, so it never holds the parent. */
function superviseExit(child, timeout, signal) {
	return new Promise((resolve) => {
		let killed = null;
		let done = false;
		let confirm;
		const settle = (code, unconfirmed) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			clearTimeout(confirm);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, killed, unconfirmed });
		};
		const kill = (why) => {
			if (killed !== null) return;
			killed = why;
			killGroup(child);
			if (done) return;
			confirm = setTimeout(() => {
				child.stdout?.destroy();
				child.stderr?.destroy();
				child.unref();
				settle(null, [child.pid]);
			}, KILL_CONFIRM_MS);
		};
		const timer = setTimeout(() => kill("timeout"), timeout);
		const onAbort = () => kill("abort");
		child.on("error", () => settle(null, []));
		child.on("exit", (code) => settle(code, []));
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** The bash a check runs through on win32 — this build's own copy of the
 *  process module's rule (tools-node `process.ts`; zero dependencies here),
 *  pinned to it by subagent-win32.test.ts. */
function resolveBash(env) {
	const fail = (message) => {
		throw Object.assign(new Error(message), { code: "KISO_NO_BASH" });
	};
	const override = env.KISO_BASH;
	if (override !== undefined && override !== "") {
		if (!/^bash(\.exe)?$/i.test(win32.basename(override))) {
			fail(`KISO_BASH must name a bash executable (bash.exe), not ${win32.basename(override)}: kiso's shell commands are POSIX shell`);
		}
		if (!existsSync(override)) fail(`KISO_BASH is set to ${override}, which does not exist`);
		return override;
	}
	for (const root of [env.ProgramFiles ?? "C:\\Program Files", env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"]) {
		const candidate = win32.join(root, "Git", "bin", "bash.exe");
		if (existsSync(candidate)) return candidate;
	}
	const system32 = win32.join(env.SystemRoot ?? "C:\\Windows", "System32").toLowerCase();
	for (const dir of (env.PATH ?? "").split(win32.delimiter)) {
		if (dir === "" || win32.join(dir, ".").toLowerCase() === system32) continue;
		const candidate = win32.join(dir, "bash.exe");
		if (existsSync(candidate)) return candidate;
	}
	return fail("no bash found — kiso runs shell commands through Git Bash on Windows: install Git for Windows, or set KISO_BASH to the path of bash.exe");
}

/** DT-1a R2.3: the parent runs the acceptance in the worktree — a configured check
 *  through /bin/sh (bash on win32; user-authored), or the evaluator binary with the
 *  worktree as its argument. Own process group (the abort and the timeout kill it whole), the
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
	let child;
	try {
		const options = { cwd: worktree, ...ownGroup(), stdio: ["ignore", "pipe", "pipe"] };
		child = kind === "check" ? spawn(process.platform === "win32" ? resolveBash(process.env) : "/bin/sh", ["-c", command], options) : spawn(command, [worktree], options);
	} catch (err) {
		// win32 with no usable bash: the check fails with a message the model can act on
		if (err?.code !== "KISO_NO_BASH") throw err;
		const name = kind === "check" ? { name: acceptance.check, command } : { evaluator: command };
		return { kind, ...name, exitCode: null, passed: false, tail: err.message, durationMs: Date.now() - started, patchSha256, baseRev };
	}
	let output = "";
	const capture = (d) => {
		if (output.length < ACCEPTANCE_OUTPUT_CAP) output += String(d).slice(0, ACCEPTANCE_OUTPUT_CAP - output.length);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const { code: exitCode, killed, unconfirmed } = await superviseExit(child, timeout, signal);
	const code = killed !== null ? null : exitCode;
	return {
		kind,
		...(kind === "check" ? { name: acceptance.check, command } : { evaluator: command }),
		exitCode: code,
		passed: code === 0,
		...(killed !== null ? { killed } : {}),
		...(unconfirmed.length > 0 ? { unconfirmed } : {}),
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

/** A child's environment — the parent's, plus the depth guard, its role
 *  policy and the sessions folder (the foreground and background share it).
 *  0.49.0 C1: a child that runs on the conversation's profile runs at the
 *  conversation's effort too (KISO_CHILD_REASONING) — and only that child:
 *  a profile the task or subagents.model named starts at its own effort. */
function childEnv(policyDir, sessionsDir, reasoning) {
	const depth = Number.parseInt(process.env.KISO_SUBAGENT_DEPTH ?? "0", 10) || 0;
	const { KISO_CHILD_REASONING: _inherited, ...parent } = process.env;
	return {
		...(reasoning !== undefined && reasoning !== null ? { KISO_CHILD_REASONING: JSON.stringify(reasoning) } : {}),
		...parent,
		KISO_SUBAGENT_DEPTH: String(depth + 1),
		KISO_EXTENSIONS_DIR: policyDir,
		// 0.40.0: the child writes its log beside its parent's — the
		// parent reads it back from there — whatever cwd it runs in
		KISO_SESSIONS_DIR: sessionsDir,
		// Modes: a headless child has no human — the mode tiers'
		// ask would stall it. Bypass is the neutral tier here; the
		// role policy dir (allow/deny only — a child must never
		// see an ask) stays the child's ONLY gate, exactly as
		// before the mode tiers existed (deny>ask>allow honors its
		// denials; the mode's all-allow never overrides them).
		KISO_MODE: "bypass",
	};
}

/** A foreground child's process. 0.49.0 C3: what it prints — stdout and
 *  stderr — streams into its output.log; nothing of it accumulates in
 *  memory, so a child that prints without bound costs the parent nothing.
 *  C2: a reader runs under its turn budget; every child writes its result
 *  record (--result-file), the parent's only source for its result. */
function runProcess({ childId, bin, cwd, policyDir, taskPath, timeout, signal, resolved, sessionsDir, childDir, maxTurns }) {
	const args = [...childArgs(bin, childId, taskPath, resolved.profile), ...(maxTurns !== undefined ? ["--max-turns", String(maxTurns)] : []), "--result-file", join(childDir, "result.md")];
	const child = spawn(process.execPath, args, {
		cwd,
		env: childEnv(policyDir, sessionsDir, resolved.reasoning),
		...ownGroup(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.end(); // CX-1 F5: nothing rides stdin — the task is the file
	const outputPath = join(childDir, "output.log");
	let fd = openSync(outputPath, "a");
	let open = 2;
	let drained;
	const allClosed = new Promise((r) => {
		drained = r;
	});
	for (const stream of [child.stdout, child.stderr]) {
		stream.on("data", (d) => {
			if (fd === -1) return;
			try {
				writeSync(fd, d);
			} catch {
				// best effort: the output is diagnostics, never the result
			}
		});
		stream.on("close", () => {
			open -= 1;
			if (open === 0) drained();
		});
	}
	return superviseExit(child, timeout, signal).then(async ({ code, killed, unconfirmed }) => {
		// the pipes drain after the exit; a child let go (unconfirmed) has
		// had them destroyed — the wait is bounded either way
		await Promise.race([allClosed, new Promise((r) => setTimeout(r, 1_000))]);
		const closing = fd;
		fd = -1;
		closeSync(closing);
		return { code: code ?? -1, killed, unconfirmed, outputPath };
	});
}

/** The role policy: read-only for explorer/reviewer, the full six for
 *  implementer/verifier. Only allow/deny — NEVER ask (a headless child cannot
 *  answer an approval prompt; ask would deadlock). */
export function rolePolicyContent(role, scope) {
	const allowed = role === "implementer" || role === "verifier" ? SIX_TOOLS : READ_ONLY;
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

// ── 0.49.0 B: writers — a private snapshot, the parent's collection ──────
// A writer owns an isolated workspace; adoption is a separate, crash-honest
// effect (the plan's third sentence). Its end is its COLLECTION: the task
// is started with agent.collect, and the host's TaskManager calls
// collectWriter once its process has ended; only `collected` ends it.

const WRITER_ROLES = ["implementer", "verifier"];
const WRITER_MAX = 4;
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;

class SnapshotRefusal extends Error {}

const gitOut = (args, opts = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...opts }).trim();

/** I3 — the dirty part of the working tree, in git's machine format
 *  (porcelain v2, NUL-separated: names with spaces, quotes or newlines
 *  survive): path → its type, the sha256 of its bytes and its exec bit, or
 *  null when it is deleted. Ignored paths are never listed. --no-optional-
 *  locks: not even the person's index stat cache is refreshed. */
function workingManifest(root, skip = []) {
	const raw = execFileSync("git", ["-C", root, "--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames"], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8");
	const paths = [];
	for (const e of raw.split("\0")) {
		if (e.startsWith("? ")) paths.push(e.slice(2));
		else if (e.startsWith("1 ")) paths.push(e.split(" ").slice(8).join(" "));
		else if (e.startsWith("u ")) paths.push(e.split(" ").slice(10).join(" "));
	}
	const entries = new Map();
	let bytes = 0;
	for (const path of paths.sort()) {
		const full = join(root, path);
		// kiso's own home and the writers' workspaces are never part of a
		// snapshot — a home inside the repository would copy itself
		if (skip.some((r) => full === r || full.startsWith(`${r}${sep}`))) continue;
		let st;
		try {
			st = lstatSync(full);
		} catch {
			entries.set(path, null); // deleted in the working tree
			continue;
		}
		if (st.isSymbolicLink()) {
			const target = readlinkSync(full);
			entries.set(path, { type: "link", sha256: createHash("sha256").update(target).digest("hex"), exec: false });
		} else if (st.isFile()) {
			const buf = readFileSync(full);
			bytes += buf.length;
			entries.set(path, { type: "file", sha256: createHash("sha256").update(buf).digest("hex"), exec: (st.mode & 0o111) !== 0 });
		}
		// a directory here is a submodule (gitlink): not part of a snapshot,
		// as a worktree never initialised one
	}
	return { entries, bytes };
}

const sameManifest = (a, b) => a.entries.size === b.entries.size && [...a.entries].every(([k, v]) => JSON.stringify(b.entries.get(k)) === JSON.stringify(v) && b.entries.has(k));

/** B6.1 — a writer's workspace: a task-private repository that borrows the
 *  person's objects read-only (`clone --shared`), checked out at HEAD, with
 *  the working tree's dirty files copied in; the snapshot is committed in
 *  the private repository and is the writer's base. Nothing is written into
 *  the person's repository. I3: accepted only if HEAD and the manifest are
 *  unchanged across the capture — else once more, then a refusal. Over the
 *  cap: a refusal, never HEAD instead. */
export function snapshotWorkspace(parentCwd, ws, maxBytes = SNAPSHOT_MAX_BYTES) {
	let root;
	let h0;
	try {
		root = gitOut(["-C", parentCwd, "rev-parse", "--show-toplevel"]);
		h0 = gitOut(["-C", root, "rev-parse", "--verify", "HEAD"]);
	} catch (err) {
		throw new SnapshotRefusal(`a writer needs a git repository with a commit: ${msg(err)}`);
	}
	const sub = relative(realpathSync(root), realpathSync(parentCwd));
	const real = (p) => {
		try {
			return realpathSync(p);
		} catch {
			return resolve(p);
		}
	};
	// both sides real paths: git's top level is, and these are made so. The
	// writers' workspaces live under kiso's home; `ws` itself is named for a
	// caller that puts it elsewhere
	const skip = [real(process.env.KISO_HOME ?? join(homedir(), ".kiso")), real(ws)];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const m0 = workingManifest(root, skip);
		if (m0.bytes > maxBytes) {
			const size = (n) => (n >= 1024 * 1024 ? `${Math.floor(n / (1024 * 1024))} MiB` : `${n} bytes`);
			throw new SnapshotRefusal(`the working-tree snapshot would copy ${size(m0.bytes)}, over ${size(maxBytes)}; commit, stash or shrink the workspace, or raise the host's limit`);
		}
		rmSync(ws, { recursive: true, force: true });
		mkdirSync(dirname(ws), { recursive: true });
		execFileSync("git", ["clone", "-q", "--shared", "--no-checkout", root, ws], { stdio: "ignore" });
		execFileSync("git", ["-C", ws, "checkout", "-q", "--detach", h0], { stdio: "ignore" });
		let stable = true;
		for (const [path, e] of m0.entries) {
			const from = join(root, path);
			const to = join(ws, path);
			if (e === null) {
				rmSync(to, { force: true });
				continue;
			}
			mkdirSync(dirname(to), { recursive: true });
			rmSync(to, { force: true });
			if (e.type === "link") {
				symlinkSync(readlinkSync(from), to);
				continue;
			}
			// copy what was hashed: a file that changed since the manifest is unstable
			const buf = readFileSync(from);
			if (createHash("sha256").update(buf).digest("hex") !== e.sha256) stable = false;
			writeFileSync(to, buf);
			chmodSync(to, e.exec ? 0o755 : 0o644);
		}
		// test-only: a file the gate touches between the copy and the re-read
		if (process.env.KISO_TEST_SNAPSHOT_TOUCH !== undefined && (attempt === 0 || process.env.KISO_TEST_SNAPSHOT_TOUCH_ALWAYS === "1")) appendFileSync(process.env.KISO_TEST_SNAPSHOT_TOUCH, "x");
		const h1 = gitOut(["-C", root, "rev-parse", "--verify", "HEAD"]);
		if (stable && h1 === h0 && sameManifest(m0, workingManifest(root, skip))) {
			execFileSync("git", ["-C", ws, "add", "-A"], { stdio: "ignore" });
			execFileSync("git", ["-C", ws, "-c", "user.name=kiso", "-c", "user.email=kiso@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "--no-verify", "-m", "kiso: the working tree at dispatch"], { stdio: "ignore" });
			return { root, head: h0, base: gitOut(["-C", ws, "rev-parse", "HEAD"]), cwd: join(ws, sub), sub };
		}
		h0 = h1;
	}
	rmSync(ws, { recursive: true, force: true });
	throw new SnapshotRefusal("the workspace changed while the snapshot was being captured (twice); let the edits settle and delegate again");
}

/** B — collect a writer that ended: called once by the host's TaskManager
 *  (its `collect` option), live or at the next open. Each step is keyed by
 *  its own record file and skipped when it is there, so a kill -9 resumes
 *  where it stopped; `collected` is written LAST. An implementer's result is
 *  its patch (and the child's acceptance); a verifier's writes are never
 *  collected — its result is its report. */
export async function collectWriter(info, manager) {
	const cfg = delegationConfig();
	const home = process.env.KISO_HOME ?? join(homedir(), ".kiso");
	const sessionsDir = cfg.sessionsDir ?? (process.env.KISO_SESSIONS_DIR || join(home, "sessions"));
	const manifestDir = artifactDir(home, sessionsDir);
	const childId = info.agent?.session;
	if (manifestDir === null || typeof childId !== "string") throw new Error("no manifest for this writer");
	const man = JSON.parse(readFileSync(join(manifestDir, `${childId}.json`), "utf8"));
	const taskDir = dirname(info.outputPath);
	const journal = join(taskDir, "journal.jsonl");
	const done = (outcome, reason) => appendFileSync(journal, `${JSON.stringify({ type: "collected", ts: Date.now(), outcome, ...(reason !== undefined ? { reason } : {}) })}\n`);
	const ws = man.workspace;
	const stopped = info.stoppedBy !== undefined;
	const { record } = readChildResult(taskDir);
	const completed = record !== null && record.outcome === "completed" && !stopped;
	if (man.role !== "implementer") {
		rmSync(ws, { recursive: true, force: true });
		return done(stopped ? "stopped" : "collected");
	}
	// 1. the patch, its index and each changed file's two versions — the one
	// step that needs the workspace: once it is recorded, a resume after a
	// crash past the workspace's removal goes straight on to `collected`
	const patchJson = join(taskDir, "patch.json");
	if (!existsSync(patchJson)) {
		if (typeof ws !== "string" || !existsSync(ws)) return done("failed", `the workspace is gone before its patch was collected: ${ws}`);
		try {
			writePatch(ws, man.base, taskDir, stopped, man.acceptance);
		} catch (err) {
			return done("failed", `collecting the patch: ${msg(err)}; the workspace is kept at ${ws}`);
		}
	}
	const patch = JSON.parse(readFileSync(patchJson, "utf8"));
	// 2. the child's acceptance — after a completed child only (DT-1a R2.3)
	const accPath = join(taskDir, "acceptance.json");
	if (man.acceptance !== undefined && completed && patch.files.length > 0 && !existsSync(accPath) && existsSync(ws)) {
		const v = await runAcceptance(man.acceptance, cfg, ws, man.base, TIMEOUT_MS, undefined);
		writeAtomic(accPath, `${JSON.stringify(v)}\n`);
	}
	// 3. a verifier `after` it: handed this tree (base + patch), started in
	// its group BEFORE `collected`, so the group never looks complete between
	const depsPath = join(taskDir, "dependents.json");
	const deps = existsSync(depsPath) ? JSON.parse(readFileSync(depsPath, "utf8")) : {};
	for (const [i, dep] of (man.dependents ?? []).entries()) {
		if (deps[dep.childId] !== undefined) continue;
		const accepted = existsSync(accPath) ? JSON.parse(readFileSync(accPath, "utf8")).passed !== false : true;
		if (!completed || patch.files.length === 0 || !accepted) {
			deps[dep.childId] = { skipped: !completed ? `the implementer did not complete (${stopped ? "stopped" : record?.outcome ?? "no result"})` : patch.files.length === 0 ? "the implementer changed nothing" : "the implementer's acceptance failed" };
		} else if (!existsSync(ws)) {
			deps[dep.childId] = { skipped: "the implementer's tree was already removed" };
		} else {
			const depWs = join(manifestDir, dep.childId, "ws");
			mkdirSync(dirname(depWs), { recursive: true });
			if (i === (man.dependents ?? []).length - 1 && existsSync(ws)) renameSync(ws, depWs);
			else cpSync(ws, depWs, { recursive: true, verbatimSymlinks: true });
			const depMan = JSON.parse(readFileSync(join(manifestDir, `${dep.childId}.json`), "utf8"));
			const depCwd = join(depWs, man.sub ?? "");
			writeDurable(join(manifestDir, `${dep.childId}.policy`, "policy.mjs"), rolePolicyContent("verifier", depMan.scope !== undefined ? { root: depCwd, globs: depMan.scope } : undefined));
			writeFileSync(join(manifestDir, `${dep.childId}.json`), `${JSON.stringify({ ...depMan, workspace: depWs, base: man.base, sub: man.sub })}\n`);
			const started = await manager.start({
				command: `verifier: ${String(depMan.task).split("\n")[0].slice(0, 80)}`,
				cwd: depCwd,
				env: childEnv(join(manifestDir, `${dep.childId}.policy`), sessionsDir, depMan.reasoning),
				...(info.executionId !== undefined ? { executionId: info.executionId } : {}),
				agent: { role: "verifier", session: dep.childId, collect: true },
				exec: (dir) => ({ file: process.execPath, args: [...childArgs(process.env.KISO_SUBAGENT_BIN ?? process.argv[1], dep.childId, join(manifestDir, `${dep.childId}.task`), depMan.model), ...(depMan.maxTurns !== undefined ? ["--max-turns", String(depMan.maxTurns)] : []), "--result-file", join(dir, "result.md")] }),
			});
			deps[dep.childId] = { taskId: started.id };
		}
		writeAtomic(depsPath, `${JSON.stringify(deps)}\n`);
	}
	// 4. the workspace goes (unless it was handed over), 5. `collected`, last
	rmSync(ws, { recursive: true, force: true });
	return done(stopped ? "stopped" : patch.files.length === 0 ? "unchanged" : "collected");
}

/** B — the patch against the snapshot (binary-safe, renames as a delete
 *  plus a create), each changed file's base and child versions, and the
 *  index that names them: patch.json, written last of the three. */
function writePatch(ws, base, taskDir, stopped, acceptance) {
	execFileSync("git", ["-C", ws, "add", "-A"], { stdio: "ignore" });
	const diff = execFileSync("git", ["-C", ws, "diff", "--cached", "--binary", "--no-renames", base], { maxBuffer: 1024 * 1024 * 1024 });
	writeAtomic(join(taskDir, "patch.diff"), diff);
	const raw = execFileSync("git", ["-C", ws, "diff", "--cached", "--no-renames", "--raw", "-z", base], { maxBuffer: 256 * 1024 * 1024 }).toString("utf8").split("\0");
	const files = [];
	const vdir = join(taskDir, "versions");
	mkdirSync(vdir, { recursive: true });
	for (let i = 0; i + 1 < raw.length; i += 2) {
		const [srcMode, dstMode, , , status] = raw[i].replace(/^:/, "").split(" ");
		const path = raw[i + 1];
		const n = files.length;
		const entry = { path, status, baseMode: srcMode, mode: dstMode };
		if (status !== "A") {
			writeFileSync(join(vdir, `${n}.base`), execFileSync("git", ["-C", ws, "show", `${base}:${path}`], { maxBuffer: 256 * 1024 * 1024 }));
		}
		if (status !== "D") {
			writeFileSync(join(vdir, `${n}.child`), execFileSync("git", ["-C", ws, "show", `:${path}`], { maxBuffer: 256 * 1024 * 1024 }));
		}
		files.push(entry);
	}
	const bytes = statSync(join(taskDir, "patch.diff")).size;
	// the acceptance by its name: apply-patch re-resolves it from the configuration
	writeAtomic(join(taskDir, "patch.json"), `${JSON.stringify({ base, bytes, files, completeness: stopped ? "partial" : "complete", applyable: !stopped, ...(acceptance !== undefined ? { acceptance } : {}) })}\n`);
}

function writeAtomic(path, content) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, content);
	renameSync(tmp, path);
}

/** 0.49.0 C1 — the conversation's live binding, as the host reports it;
 *  null when the host gives none (an SDK caller, a test) or fails. */
function bindingOf(host, sessionId) {
	if (typeof host.currentBinding !== "function") return null;
	try {
		const b = host.currentBinding(sessionId);
		return b !== null && typeof b === "object" ? b : null;
	} catch {
		return null;
	}
}

/** 0.49.0 C1 — which profile a child runs on, and at what effort. The first
 *  that applies wins: the task's own `model`; the user's subagents.model;
 *  the conversation's profile, with the conversation's effort; else none —
 *  the child inherits the environment, and its handoff says so. Resolved at
 *  dispatch, so a /model switch between two delegations is honoured. */
export function resolveChild(task, cfg, binding) {
	if (task.model !== undefined) return { profile: task.model, source: "task" };
	if (cfg.subagentsModel !== undefined) return { profile: cfg.subagentsModel, source: "subagents.model" };
	if (binding !== null && typeof binding.profile === "string" && binding.profile !== "") {
		return { profile: binding.profile, ...(binding.reasoning !== undefined && binding.reasoning !== null ? { reasoning: binding.reasoning } : {}), source: "conversation" };
	}
	return { source: "environment" };
}

/** The resolution as a manifest records it — a restart replays it. */
function modelFieldsOf(resolved) {
	return { modelSource: resolved.source, ...(resolved.profile !== undefined ? { model: resolved.profile } : {}), ...(resolved.reasoning !== undefined ? { reasoning: resolved.reasoning } : {}) };
}

/** I5: a child's result — its record (result.json) commits its answer
 *  (result.md); without a valid record there is no answer to read. */
function readChildResult(childDir) {
	let raw = null;
	try {
		raw = readFileSync(join(childDir, "result.json"), "utf8");
	} catch {
		raw = null;
	}
	const record = handoffRecordOf(raw);
	if (record === null) return { record: null, full: null, answer: "" };
	let answer = "";
	try {
		answer = readFileSync(join(childDir, "result.md"), "utf8");
	} catch {
		answer = "";
	}
	return { record, full: JSON.parse(raw), answer };
}

/** The last `bytes` of a file as read, and whether it held more — the
 *  runtime delivery's reader, the same way. */
function rawTail(path, bytes) {
	try {
		const fd = openSync(path, "r");
		try {
			const size = statSync(path).size;
			const n = Math.min(size, bytes);
			const buf = Buffer.alloc(n);
			readSync(fd, buf, 0, n, size - n);
			return { text: buf.toString("utf8"), cut: size > n };
		} finally {
			closeSync(fd);
		}
	} catch {
		return { text: "", cut: false };
	}
}

// ── The handoff format (0.49.0 C3/I7) ───────────────────────────────────
// The runtime's tasks/handoff.ts, byte for byte: this extension has no
// runtime dependency, so it carries its own copy, and the corpus in
// tests/fixtures/handoff holds both to the same expected bytes.

export const CHILD_HANDOFF_BYTES = 4_096;
export const GROUP_HANDOFF_BYTES = 16_384;
export const HANDOFF_TAIL_BYTES = 2_048;
export const HANDOFF_ERROR_BYTES = 1_024;

/** The record a result.json holds, or null — the commit test (I5). */
export function handoffRecordOf(raw) {
	if (raw === null) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || typeof parsed.outcome !== "string" || parsed.outcome === "") return null;
		return typeof parsed.error === "string" && parsed.error !== "" ? { outcome: parsed.outcome, error: parsed.error } : { outcome: parsed.outcome };
	} catch {
		return null;
	}
}

/** One child's handoff body: lines each led by "\n", and the bytes shown. */
export function handoffBody(input, budget) {
	let text = "";
	let used = 0;
	const room = () => Math.max(0, budget - used);
	if (input.record?.error !== undefined) {
		const line = headOf(`error: ${input.record.error.replace(/\s*\n\s*/g, " ").trim()}`, Math.min(HANDOFF_ERROR_BYTES, room()));
		if (line.text !== "") {
			text += `\n${line.text}${line.cut ? "…" : ""}`;
			used += Buffer.byteLength(line.text);
		}
	}
	const answer = input.record === null ? "" : input.answer.trimEnd();
	if (answer !== "") {
		if (Buffer.byteLength(answer) <= room()) return { text: `${text}\n${answer}`, bytes: used + Buffer.byteLength(answer) };
		if (room() === 0) return { text: `${text}\n[the whole answer: ${input.resultPath}]`, bytes: used };
		const cut = headOf(answer, room()).text;
		return { text: `${text}\n${cut}\n… [truncated; the whole answer: ${input.resultPath}]`, bytes: used + Buffer.byteLength(cut) };
	}
	const tail = input.tail.trimEnd();
	if (tail !== "") {
		const kept = tailOf(tail, Math.min(HANDOFF_TAIL_BYTES, room()));
		if (kept.text !== "") {
			text += `\n${input.tailCut || kept.cut ? "…" : ""}${kept.text}`;
			used += Buffer.byteLength(kept.text);
		}
	}
	return { text, bytes: used };
}

/** The first `bytes` of `s`, never splitting a character. */
function headOf(s, bytes) {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= bytes) return { text: s, cut: false };
	return { text: buf.subarray(0, Math.max(0, bytes)).toString("utf8").replace(/�+$/, ""), cut: true };
}

/** The last `bytes` of `s`, never splitting a character. */
function tailOf(s, bytes) {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= bytes) return { text: s, cut: false };
	return { text: buf.subarray(buf.length - Math.max(0, bytes)).toString("utf8").replace(/^�+/, ""), cut: true };
}

function failSection(childId, role, task, reason) {
	return { failed: true, failKind: "error", text: `[subagent] ${role}: ${task}\n  FAILED: ${reason}`, toolCalls: 0 };
}

const msg = (err) => (err instanceof Error ? err.message : String(err));
