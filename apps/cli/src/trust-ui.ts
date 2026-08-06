/**
 * 手感批 B4 (pure move) — the human-facing question UI: the E3 project
 * trust gate (ADR-0037), the mcp/skills env merges, the generic ask()
 * (approvals, trust, uncertain resolutions), and the uncertain-execution
 * decisions. All bodies moved verbatim from index.ts.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeTerminal, palette } from "@vincemakes/kiso-tui";
import { projectArtifacts, recordTrust, trustFor, type ProjectArtifacts } from "@vincemakes/kiso-runtime";
import type { AgentSession } from "@vincemakes/kiso-runtime";
import { CANCELLED, bodyLog, dock, kisoHome, mergedTempPaths, type LineInput } from "./state.js";

/** v2a: the interactive prompt — blue, the identity accent. readline owns
 *  the echo of what the user types; we own the prompt's color. (v2c: the
 *  readline prompt keeps "you> " — the brick ▌ is the dock's row only;
 *  pipe bytes must not change.) */
export function interactivePrompt(): string {
	const p = palette();
	return `${p.blue}you> ${p.reset}`;
}

/**
 * Ask the human a question. Non-interactive stdin (piped, CI) cannot wait
 * forever: approvals auto-deny and uncertain executions auto-abandon, both
 * printed loudly — never silently ignored, never hung (Area 7).
 *
 * 八/十: the question is ABORTABLE — a pending rl.question is registered in
 * `pendingAsk` and the SIGINT handler resolves it with the CANCELLED
 * sentinel. The rl.question callback is NOT left dangling: an input that
 * arrives after the cancellation is re-emitted as a fresh "line" — it
 * becomes the next user turn instead of being swallowed by the dead
 * question.
 */
export let pendingAsk: (() => void) | null = null;
export function ask(input: LineInput, question: string): Promise<string | typeof CANCELLED> {
	if (!process.stdin.isTTY) {
		console.log(`[non-interactive — no human to ask: ${question}]`);
		return Promise.resolve("");
	}
	// v2b: docked — the question takes over the status position, the
	// answer lands at the input line. v2c: a TTY without a dock (rows < 4)
	// prints the question into the body — the editor cannot show it.
	if (dock.active) {
		dock.showQuestion(question);
	} else {
		bodyLog(question);
	}
	return new Promise((resolve) => {
		let settled = false;
		pendingAsk = () => {
			if (settled) return;
			settled = true;
			pendingAsk = null;
			input.cancelQuestion();
			resolve(CANCELLED); // the run is aborting — the question is dead
		};
		// v2b: docked — the question reads at the input line, whose prompt
		// is the same blue you> (the editor's brick row; the readline path
		// passes the plain question). An empty prompt would start readline
		// at column 1 while the dock renders "you> " — the typed answer
		// would land on the prompt and drift (probe-confirmed).
		input.question(dock.active ? interactivePrompt() : question, (answer) => {
			if (settled) {
				// The question was cancelled; this line is a NEW user turn.
				input.emitLine(answer);
				return;
			}
			settled = true;
			pendingAsk = null;
			if (dock.active) dock.clearQuestion();
			resolve(answer);
		});
	});
}

/**
 * E3 — the project-level trust gate (ADR-0037): capability is trusted by
 * content digest, not by directory. Runs BEFORE any extension loads — the
 * mcp/skills merges must be in the env before the user-level extensions are
 * loaded (the mcp factory reads KISO_MCP_CONFIG at load time, the skills
 * extension scans KISO_SKILLS_DIR at load time).
 *
 * Verdicts: granted → load; refused → never load, never re-ask (refused is
 * sticky — re-evaluate by deleting the trust line or changing a file); no
 * record → only a HUMAN may decide, TTY only — non-TTY refuses with one
 * stderr line. Returns the artifacts on grant, null on anything else.
 */
export async function resolveProjectTrust(input: LineInput): Promise<ProjectArtifacts | null> {
	const artifacts = await projectArtifacts(process.cwd());
	if (artifacts === null) return null; // no .kiso artifacts — nothing to gate
	const record = trustFor(artifacts.root, artifacts.digest);
	if (record?.decision === "granted") {
		applyProjectMerges(artifacts);
		return artifacts;
	}
	if (record?.decision === "refused") return null; // refused is sticky — no re-ask
	// First discovery — list every artifact (file name + digest short
	// prefix) and ask the human ONCE.
	if (!process.stdin.isTTY) {
		console.error(
			`[project .kiso] found ${artifacts.files.length} artifact(s) in ${artifacts.root} — not trusted, not loaded (run kiso interactively once to decide)`,
		);
		return null;
	}
	// v2c: the shared input (the editor on a TTY) reads the answer; the
	// dock shows the question at the status position.
	bodyLog(`[project .kiso] ${artifacts.root}`);
	for (const f of artifacts.files) {
		bodyLog(`  ${f.path}  (${f.digest.slice(0, 6)})`);
	}
	const answer = await ask(input, `trust this project's .kiso? (y/n) `);
	const granted = answer !== CANCELLED && answer.trim().toLowerCase().startsWith("y");
	recordTrust({ root: artifacts.root, digest: artifacts.digest, decision: granted ? "granted" : "refused" });
	if (!granted) return null;
	applyProjectMerges(artifacts);
	return artifacts;
}

/**
 * E3 — merge the project's mcp.json and skills into the env BEFORE the
 * extension load. A server name in BOTH configs is a LOUD error (a silent
 * override would be a supply-chain surprise); a skill name in both merges
 * with project-wins and a stderr note. Exported for tests.
 */
export function applyProjectMerges(artifacts: ProjectArtifacts): void {
	if (artifacts.files.some((f) => f.kind === "mcp")) applyMcpMerge(artifacts.root);
	if (artifacts.files.some((f) => f.kind === "skill")) applySkillsMerge(artifacts.root);
}

/** Read an mcp.json with the mcp extension's tolerance: absent/unreadable →
 *  {}, present-but-broken → throw (the loader convention). */
function readMcpConfig(path: string): { mcpServers?: Record<string, unknown> } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		throw new Error(`[project .kiso] cannot parse ${path}: ${(err as Error).message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`[project .kiso] ${path} must be an object with an mcpServers map`);
	}
	return parsed as { mcpServers?: Record<string, unknown> };
}

/** Merge user-level + project-level mcp.json into one temp file and point
 *  KISO_MCP_CONFIG at it — the mcp extension reads it at load time. */
function applyMcpMerge(root: string): void {
	const userPath = process.env.KISO_MCP_CONFIG ?? join(kisoHome(), "mcp.json");
	const user = readMcpConfig(userPath);
	const project = readMcpConfig(join(root, "mcp.json"));
	const userServers = user.mcpServers ?? {};
	const projectServers = project.mcpServers ?? {};
	if (Object.keys(projectServers).length === 0) return; // nothing to merge
	for (const name of Object.keys(projectServers)) {
		if (name in userServers) {
			throw new Error(`[project .kiso] mcp server "${name}" exists in both the user-level and the project-level mcp.json`);
		}
	}
	const merged = { mcpServers: { ...userServers, ...projectServers } };
	const temp = join(tmpdir(), `kiso-mcp-merged-${process.pid}.json`);
	writeFileSync(temp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
	process.env.KISO_MCP_CONFIG = temp;
	mergedTempPaths.push(temp);
}

/** Merge user-level + project-level skills into one temp scan dir (project
 *  skill dirs symlinked first; a name in both → project wins + a stderr
 *  note) and point KISO_SKILLS_DIR at it — the skills extension's existing
 *  scan reads it at load time and per read_skill call. */
function applySkillsMerge(root: string): void {
	const userDir = process.env.KISO_SKILLS_DIR ?? join(kisoHome(), "skills");
	const projectDir = join(root, "skills");
	const merged = mkdtempSync(join(tmpdir(), "kiso-skills-"));
	mergedTempPaths.push(merged);
	for (const dir of readdirSyncSafe(projectDir)) {
		symlinkSync(join(projectDir, dir), join(merged, dir)); // project wins on collision
	}
	for (const dir of readdirSyncSafe(userDir)) {
		const target = join(merged, dir);
		if (existsSync(target)) {
			console.error(`[project .kiso] skill "${dir}" exists in both user and project skills — project wins`);
			continue;
		}
		symlinkSync(join(userDir, dir), target);
	}
	process.env.KISO_SKILLS_DIR = merged;
}

function readdirSyncSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return []; // no skills dir on either level = nothing to merge
	}
}

/** Decide every uncertain execution with the human (r)erun/(a)bandon. */
export async function resolveUncertains(
	session: AgentSession,
	input: LineInput,
	isCancelled: () => boolean,
): Promise<void> {
	for (const uncertain of session.uncertainExecutions()) {
		const answer = await ask(
			input,
			`⚠ interrupted execution: ${escapeTerminal(uncertain.name)} (${uncertain.executionId}) — did it apply? (r)erun / (a)bandon: `,
		);
		if (isCancelled() || answer === CANCELLED) {
			// 十: a cancellation NEVER records a verdict — the execution
			// stays uncertain and durable; no rerun/abandoned is fabricated.
			return;
		}
		const resolution = answer.trim().toLowerCase().startsWith("r") ? "rerun" : "abandoned";
		await session.resolveUncertain(uncertain.executionId, resolution);
		console.log(`  ${resolution}\n`);
	}
}
