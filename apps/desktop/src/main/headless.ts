import { startFromEnv } from "./env.js";

/**
 * The host without Electron — what the spike scripts spawn, and what a
 * future `kiso-desktop --headless` would be. Configuration: env.ts. It
 * prints one line, `READY {json}`, once it listens.
 */

async function main(): Promise<void> {
	const host = await startFromEnv();
	const ready = { origin: host.origin, port: host.port, token: host.token, pid: process.pid, openRuns: host.service.openRuns() };
	process.stdout.write(`READY ${JSON.stringify(ready)}\n`);
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		void host.close(5_000).then(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main().catch((err) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
});
