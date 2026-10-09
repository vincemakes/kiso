/** The built artifact has no .d.ts — declare its exports for the tests. */
declare module "*.mjs" {
	const factory: (host?: import("../index.js").SubagentHost) => Promise<import("@vincemakes/kiso-core").KisoExtension>;
	export default factory;
	export function rolePolicyContent(role: string, scope?: { root: string; globs: readonly string[] }): string;
	export function extractChildResult(
		sessionsDir: string,
		childId: string,
		diag: string,
	): Promise<{
		outcome: string;
		toolCalls: number;
		text: string;
		usage: { completedResponses: number | null; abandonedAttempts: number | null; inputTokens: number | null; outputTokens: number | null; cacheRead: number | null };
		failed: boolean;
		reason: string;
		diag: string;
	}>;
	// 0.40.0: the settled row's marker and the failure kinds it counts
	export type FailKind = "timeout" | "acceptance" | "error";
	export function failKindOf(status: string, verification: { passed?: boolean; skipped?: string } | null): FailKind;
	export function delegateSummary(sections: readonly { failed: boolean; failKind?: FailKind; toolCalls?: number }[], roles: number): string;
	// DT-1a
	export const UNRESOLVED_INSTRUCTION: string;
	export function globToRegExp(glob: string): RegExp;
	export function pathInScope(root: string, target: string, globs: readonly string[]): boolean;
	export function parseUnresolved(text: string | null | undefined): string[] | null;
	export function parseChangedFiles(numstat: string, nameStatus: string): { path: string; status: string; from?: string; binary?: true; added?: number; removed?: number }[];
	export function validateTask(task: unknown, cfg: { checks: Record<string, string>; evaluators?: string[]; profiles: string[] }, parentCwd: string, manifestDir: string): string | null;
	export function childArgs(bin: string, childId: string, taskPath: string, model?: string): string[];
	// 0.49.0 C1: which profile a child runs on, and at what effort
	export function resolveChild(
		task: { model?: string },
		cfg: { subagentsModel?: string },
		binding: { profile: string | null; reasoning?: { thinking: string; effort: string } } | null,
	): { profile?: string; reasoning?: { thinking: string; effort: string }; source: "task" | "subagents.model" | "conversation" | "environment" };
	// 0.49.0 C3/I7: the handoff format (the runtime's tasks/handoff.ts, byte for byte)
	export const CHILD_HANDOFF_BYTES: number;
	export const GROUP_HANDOFF_BYTES: number;
	export const HANDOFF_TAIL_BYTES: number;
	export const HANDOFF_ERROR_BYTES: number;
	export function handoffRecordOf(raw: string | null): { outcome: string; error?: string } | null;
	export function handoffBody(
		input: { record: { outcome: string; error?: string } | null; answer: string; tail: string; tailCut: boolean; resultPath: string },
		budget: number,
	): { text: string; bytes: number };
	export function runAcceptance(
		acceptance: { check?: string; evaluator?: string },
		cfg: { checks: Record<string, string> },
		worktree: string,
		baseRev: string | null,
		timeout: number,
		signal?: AbortSignal,
	): Promise<{ kind: string; exitCode: number | null; passed: boolean; killed?: "timeout" | "abort"; unconfirmed?: number[]; tail: string; durationMs: number; patchSha256: string }>;
}
