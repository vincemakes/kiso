/** The built artifact has no .d.ts — declare its exports for the tests. */
declare module "*.mjs" {
	const factory: () => Promise<import("@vincemakes/kiso-core").KisoExtension>;
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
	// DT-1a
	export const UNRESOLVED_INSTRUCTION: string;
	export function globToRegExp(glob: string): RegExp;
	export function pathInScope(root: string, target: string, globs: readonly string[]): boolean;
	export function parseUnresolved(text: string | null | undefined): string[] | null;
	export function parseChangedFiles(numstat: string, nameStatus: string): { path: string; status: string; from?: string; binary?: true; added?: number; removed?: number }[];
	export function validateTask(task: unknown, cfg: { checks: Record<string, string>; profiles: string[] }, parentCwd: string, manifestDir: string): string | null;
	export function childArgs(bin: string, childId: string, taskPath: string, model?: string): string[];
	export function runAcceptance(
		acceptance: { check?: string; evaluator?: string },
		cfg: { checks: Record<string, string> },
		worktree: string,
		baseRev: string | null,
		timeout: number,
		signal?: AbortSignal,
	): Promise<{ kind: string; exitCode: number | null; passed: boolean; tail: string; durationMs: number; patchSha256: string }>;
}
