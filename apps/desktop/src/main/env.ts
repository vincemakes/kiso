import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, projectDirFor } from "@vincemakes/kiso-code/config";
import { kisoHome, SessionStore } from "@vincemakes/kiso-runtime";
import { startHost, type Host } from "./host.js";
import type { ModelChoice, PermissionMode } from "./agent.js";

/**
 * The host's configuration from the environment — shared by the headless
 * entry and the Electron main, so a credential never rides argv:
 *
 *   KISO_DESKTOP_DATA        the kiso home: `projects/<enc>/` under it holds the Works (default: the terminal's own home)
 *   KISO_DESKTOP_WORKSPACE   the folder a new task starts in (default: the folder used last, else the working directory)
 *   KISO_DESKTOP_FAUX        path to a JSON FauxScript (the keyless model)
 *   KISO_DESKTOP_FAUX_SKIP   a session id: skip the script turns its log already consumed
 *   KISO_DESKTOP_PROVIDER    JSON { provider, model, baseUrl? } with KISO_DESKTOP_API_KEY
 *   KISO_DESKTOP_MODE        the permission tier: default | accept-edits | plan | full-access
 *   KISO_DESKTOP_SANITIZER   "default" | "desktop"
 *   KISO_DESKTOP_THINKING    0: leave reasoning text off the wire (default: on)
 *   KISO_DESKTOP_KEEPALIVE   keepalive period in ms
 *   KISO_DESKTOP_MIN_FG_MS   the shell's least foreground wait (0 keeps the model's value)
 *   KISO_DESKTOP_PORT        a fixed port, and KISO_DESKTOP_TOKEN a fixed token — the
 *                            crash script restarts the host where a live client expects it
 *
 */

function need(name: string): string {
	const v = process.env[name];
	if (v === undefined || v === "") throw new Error(`${name} is required`);
	return v;
}

/** How many faux-script turns a session's log has consumed (the same rule
 *  the terminal's fauxSkip states: a turn is consumed by a tool result or an
 *  end_turn stop, or by an unfinished call the recovery completes). */
function fauxSkip(sessionsDir: string, sessionId: string): number {
	const store = new SessionStore(sessionsDir);
	const events = store.load(sessionId).map((r) => r.event);
	store.closeAll();
	const results = new Set(events.filter((e) => e.type === "tool_result").map((e) => e.callId));
	return (
		events.filter((e) => e.type === "tool_result").length +
		events.filter((e) => e.type === "stop" && e.reason === "end_turn").length +
		events.filter((e) => e.type === "tool_call_end" && !results.has(e.callId)).length
	);
}

async function modelFromEnv(sessionsDir: string): Promise<ModelChoice> {
	const fauxPath = process.env["KISO_DESKTOP_FAUX"];
	if (fauxPath !== undefined && fauxPath !== "") {
		const { createFauxProvider } = await import("@vincemakes/kiso-evals");
		const script = JSON.parse(readFileSync(fauxPath, "utf8")) as Parameters<typeof createFauxProvider>[0];
		const skipFor = process.env["KISO_DESKTOP_FAUX_SKIP"];
		const skip = skipFor === undefined || skipFor === "" ? 0 : fauxSkip(sessionsDir, skipFor);
		return { kind: "adapter", adapter: createFauxProvider(script.slice(skip)), model: "faux", route: "adapter" };
	}
	const spec = JSON.parse(need("KISO_DESKTOP_PROVIDER")) as { provider: "anthropic" | "openai-compat" | "openai-responses"; model: string; baseUrl?: string; reasoning?: { thinking: string; effort: string } };
	const apiKey = need("KISO_DESKTOP_API_KEY");
	delete process.env["KISO_DESKTOP_API_KEY"]; // read once; no child process inherits it
	return { kind: "provider", ...spec, apiKey } as ModelChoice;
}

const MODES: readonly PermissionMode[] = ["default", "accept-edits", "plan", "full-access"];

function modeFromEnv(): PermissionMode {
	const raw = process.env["KISO_DESKTOP_MODE"];
	if (raw === undefined || raw === "") return "default";
	const mode = MODES.find((m) => m === raw);
	if (mode === undefined) throw new Error(`KISO_DESKTOP_MODE must be one of ${MODES.join(", ")}`);
	return mode;
}

/** The folder a new task starts in: named by the environment, else the one used last, else where the app was started. */
function workspaceFor(home: string): string {
	const named = process.env["KISO_DESKTOP_WORKSPACE"];
	if (named !== undefined && named !== "") return named;
	try {
		const last = (JSON.parse(readFileSync(join(home, "desktop.json"), "utf8")) as { lastFolder?: unknown }).lastFolder;
		if (typeof last === "string" && last !== "") return last;
	} catch {
		// nothing used yet
	}
	return process.cwd();
}

/** Remember the folder in use, for the next start. */
function rememberFolder(home: string, workspace: string): void {
	try {
		mkdirSync(home, { recursive: true, mode: 0o700 });
		writeFileSync(join(home, "desktop.json"), `${JSON.stringify({ lastFolder: workspace })}\n`, { mode: 0o600 });
	} catch {
		// a read-only home only loses the memory
	}
}

export async function startFromEnv(): Promise<Host> {
	const home = process.env["KISO_DESKTOP_DATA"] ?? kisoHome();
	const workspace = canonicalPath(workspaceFor(home));
	rememberFolder(home, workspace);
	const keepalive = Number(process.env["KISO_DESKTOP_KEEPALIVE"] ?? "");
	const minFg = Number(process.env["KISO_DESKTOP_MIN_FG_MS"] ?? "");
	return startHost({
		home,
		workspace,
		model: await modelFromEnv(projectDirFor(home, workspace)),
		mode: modeFromEnv(),
		secretEnvNames: ["KISO_DESKTOP_API_KEY"],
		exposeThinking: process.env["KISO_DESKTOP_THINKING"] !== "0",
		...(process.env["KISO_DESKTOP_PORT"] !== undefined ? { port: Number(process.env["KISO_DESKTOP_PORT"]) } : {}),
		...(process.env["KISO_DESKTOP_TOKEN"] !== undefined ? { token: process.env["KISO_DESKTOP_TOKEN"] } : {}),
		sanitizer: process.env["KISO_DESKTOP_SANITIZER"] === "default" ? "default" : "desktop",
		...(Number.isFinite(keepalive) && keepalive > 0 ? { keepaliveMs: keepalive } : {}),
		...(process.env["KISO_DESKTOP_MIN_FG_MS"] !== undefined && Number.isFinite(minFg) ? { toolLimits: { minForegroundMs: minFg } } : {}),
	});
}
