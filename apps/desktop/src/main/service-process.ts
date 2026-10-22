import { startFromEnv } from "./env.js";

/**
 * The entry of the Electron utility process that holds the host: the
 * session service, the loopback listener and the frames. A crash here ends
 * this process only; the main process keeps the window and starts another
 * (main.ts), on the same port and token, so the page's client reconnects.
 * Configuration comes in the environment (env.ts); the one message in is
 * `stop`, the messages out are `ready` and `failed`.
 */

const parent = process.parentPort;

try {
	const host = await startFromEnv();
	parent.postMessage({ type: "ready", origin: host.origin, port: host.port, token: host.token, pid: process.pid, openRuns: host.service.openRuns() });
	parent.on("message", (e) => {
		if ((e.data as { type?: string } | null)?.type !== "stop") return;
		void host.close(5_000).then(() => process.exit(0));
	});
} catch (err) {
	parent.postMessage({ type: "failed", message: err instanceof Error ? err.message : String(err) });
	process.exit(1);
}
