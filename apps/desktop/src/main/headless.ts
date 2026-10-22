import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { startHost, type Host } from "./host.js";
import type { ModelChoice } from "./agent.js";

/**
 * The host without Electron — what the spike scripts spawn, and what a
 * future `kiso-desktop --headless` would be. Configured by environment so a
 * credential never rides argv:
 *
 *   KISO_DESKTOP_DATA        the data directory (required)
 *   KISO_DESKTOP_WORKSPACE   the tools' workspace (required)
 *   KISO_DESKTOP_FAUX        path to a JSON FauxScript (the keyless model)
 *   KISO_DESKTOP_FAUX_SKIP   a session id: skip the script turns its log already consumed
 *   KISO_DESKTOP_PROVIDER    JSON { provider, model, baseUrl? } with KISO_DESKTOP_API_KEY
 *   KISO_DESKTOP_ALLOW_ALL   1: no approvals
 *   KISO_DESKTOP_SANITIZER   "default" | "desktop"
 *   KISO_DESKTOP_KEEPALIVE   keepalive period in ms
 *   KISO_DESKTOP_MIN_FG_MS   the shell's least foreground wait (0 keeps the model's value)
 *
 * It prints one line, `READY {json}`, once it listens.
 */

function need(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`${name} is required`);
	return v;
}

/** How many faux-script turns a session's log has consumed (the same rule
 *  the terminal's fauxSkip states: a turn is consumed by a tool result or an
 *  end_turn stop, or by an unfinished call the recovery completes). */
function fauxSkip(dataDir: string, sessionId: string): number {
	const store = new SessionStore(join(dataDir, "sessions"));
	const events = store.load(sessionId).map((r) => r.event);
	store.closeAll();
	const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => e.callId));
	return (
		events.filter((e) => e.type === "tool_result").length +
		events.filter((e) => e.type === "stop" && e.reason === "end_turn").length +
		events.filter((e) => e.type === "tool_call_end" && !results.has(e.callId)).length
	);
}

async function modelFromEnv(dataDir: string): Promise<ModelChoice> {
	const fauxPath = process.env["KISO_DESKTOP_FAUX"];
	if (fauxPath !== undefined && fauxPath !== "") {
		const { createFauxProvider } = await import("@vincemakes/kiso-evals");
		const script = JSON.parse(readFileSync(fauxPath, "utf8")) as Parameters<typeof createFauxProvider>[0];
		const skipFor = process.env["KISO_DESKTOP_FAUX_SKIP"];
		const skip = skipFor === undefined || skipFor === "" ? 0 : fauxSkip(dataDir, skipFor);
		return { kind: "adapter", adapter: createFauxProvider(script.slice(skip)), model: "faux", route: "adapter" };
	}
	const spec = JSON.parse(need("KISO_DESKTOP_PROVIDER")) as { provider: "anthropic" | "openai-compat" | "openai-responses"; model: string; baseUrl?: string };
	return { kind: "provider", ...spec, apiKey: need("KISO_DESKTOP_API_KEY") };
}

export async function startFromEnv(): Promise<Host> {
	const dataDir = need("KISO_DESKTOP_DATA");
	const keepalive = Number(process.env["KISO_DESKTOP_KEEPALIVE"] ?? "");
	const minFg = Number(process.env["KISO_DESKTOP_MIN_FG_MS"] ?? "");
	return startHost({
		dataDir,
		workspace: need("KISO_DESKTOP_WORKSPACE"),
		model: await modelFromEnv(dataDir),
		allowAll: process.env["KISO_DESKTOP_ALLOW_ALL"] === "1",
		sanitizer: process.env["KISO_DESKTOP_SANITIZER"] === "default" ? "default" : "desktop",
		...(Number.isFinite(keepalive) && keepalive > 0 ? { keepaliveMs: keepalive } : {}),
		...(process.env["KISO_DESKTOP_MIN_FG_MS"] !== undefined && Number.isFinite(minFg) ? { toolLimits: { minForegroundMs: minFg } } : {}),
	});
}

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
