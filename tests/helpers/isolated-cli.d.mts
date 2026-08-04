/** Type declarations for the shared CLI-e2e isolation helper. */

export interface IsolatedDirs {
	readonly home: string;
	readonly extensions: string;
	readonly skills: string;
	readonly mcpConfig: string;
}

export interface IsolatedEnv {
	readonly dirs: IsolatedDirs;
	readonly env: NodeJS.ProcessEnv;
}

export function isolatedEnv(extra?: NodeJS.ProcessEnv): IsolatedEnv;

export interface CliResult {
	readonly status: number | null;
	readonly stdout: string;
	readonly stderr: string;
}

export function runCli(
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	options?: { readonly input?: string; readonly timeout?: number; readonly cwd?: string },
): CliResult;
