import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath, projectDirFor } from "@vincemakes/kiso-code/config";
import { kisoHome } from "@vincemakes/kiso-runtime";
import { fauxSkip } from "./faux.js";
import { startHost, type Host } from "./host.js";
import type { ModelChoice, PermissionMode } from "./agent.js";
import { Settings } from "./settings.js";
import type { ApprovalNotice } from "./approvals.js";

/**
 * The host's configuration from the environment — shared by the headless
 * entry and the Electron main, so a credential never rides argv:
 *
 *   KISO_DESKTOP_DATA        the kiso home: `projects/<enc>/` under it holds the Works (default: the terminal's own home)
 *   KISO_DESKTOP_WORKSPACE   the folder a new task starts in (default: the folder used last, else the working directory)
 *   KISO_DESKTOP_FAUX        path to a JSON FauxScript (the keyless model)
 *   KISO_DESKTOP_FAUX_SKIP   a session id: skip the script turns its log already consumed
 *   KISO_DESKTOP_MODE        the permission tier: default | accept-edits | plan | full-access
 *   KISO_DESKTOP_NOTIFY_LOG  a file: approval notices are appended to it (JSON lines) instead of reaching the system (the proofs)
 *   KISO_DESKTOP_SANITIZER   "default" | "desktop"
 *   KISO_DESKTOP_THINKING    0: leave reasoning text off the wire (default: on)
 *   KISO_DESKTOP_KEEPALIVE   keepalive period in ms
 *   KISO_DESKTOP_MIN_FG_MS   the shell's least foreground wait (0 keeps the model's value)
 *   KISO_DESKTOP_PORT        a fixed port, and KISO_DESKTOP_TOKEN a fixed token — the
 *                            crash script restarts the host where a live client expects it
 *
 */

/** A scripted model, for the proofs; otherwise null: the model comes from the shared configuration (settings.ts). */
async function fauxFromEnv(sessionsDir: string): Promise<ModelChoice | null> {
	const fauxPath = process.env["KISO_DESKTOP_FAUX"];
	if (fauxPath === undefined || fauxPath === "") return null;
	const { createFauxProvider } = await import("@vincemakes/kiso-evals");
	const script = JSON.parse(readFileSync(fauxPath, "utf8")) as Parameters<typeof createFauxProvider>[0];
	const skipFor = process.env["KISO_DESKTOP_FAUX_SKIP"];
	const skip = skipFor === undefined || skipFor === "" ? 0 : fauxSkip(sessionsDir, skipFor);
	return { kind: "adapter", adapter: createFauxProvider(script.slice(skip)), model: "faux", route: "adapter" };
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
function workspaceFor(settings: Settings): string {
	const named = process.env["KISO_DESKTOP_WORKSPACE"];
	if (named !== undefined && named !== "") return named;
	// an app started from Finder or the Dock has "/" as its working directory: never a place to work, so it starts in the home folder
	const cwd = process.cwd();
	return settings.lastFolder() ?? (cwd === "/" ? homedir() : cwd);
}

/** Where an approval notice goes: a file in a proof, else the main process (from a utility process), else the caller's own channel. */
function notifier(own?: (n: ApprovalNotice) => void): ((n: ApprovalNotice) => void) | undefined {
	const log = process.env["KISO_DESKTOP_NOTIFY_LOG"];
	if (log !== undefined && log !== "") return (n) => appendFileSync(log, `${JSON.stringify(n)}\n`);
	const port = (process as { parentPort?: { postMessage(message: unknown): void } }).parentPort;
	if (port !== undefined) return (n) => port.postMessage({ type: "notify", notice: n });
	return own;
}

export async function startFromEnv(options: { readonly notify?: (n: ApprovalNotice) => void } = {}): Promise<Host> {
	const home = process.env["KISO_DESKTOP_DATA"] ?? kisoHome();
	// the terminal's configuration and sign-in are read from the one root the terminal uses
	process.env["KISO_HOME"] ??= home;
	const keepalive = Number(process.env["KISO_DESKTOP_KEEPALIVE"] ?? "");
	const minFg = Number(process.env["KISO_DESKTOP_MIN_FG_MS"] ?? "");
	// settings first: its saved tier and folder memory are read before anything is opened
	const probe = new Settings(home, null, modeFromEnv());
	const workspace = canonicalPath(workspaceFor(probe));
	const faux = await fauxFromEnv(projectDirFor(home, workspace));
	const settings = faux === null ? probe : new Settings(home, faux, modeFromEnv());
	settings.write({ lastFolder: workspace });
	return startHost({
		home,
		workspace,
		settings,
		...(notifier(options.notify) !== undefined ? { notify: notifier(options.notify)! } : {}),
		exposeThinking: process.env["KISO_DESKTOP_THINKING"] !== "0",
		...(process.env["KISO_DESKTOP_PORT"] !== undefined ? { port: Number(process.env["KISO_DESKTOP_PORT"]) } : {}),
		...(process.env["KISO_DESKTOP_TOKEN"] !== undefined ? { token: process.env["KISO_DESKTOP_TOKEN"] } : {}),
		sanitizer: process.env["KISO_DESKTOP_SANITIZER"] === "default" ? "default" : "desktop",
		...(Number.isFinite(keepalive) && keepalive > 0 ? { keepaliveMs: keepalive } : {}),
		...(process.env["KISO_DESKTOP_MIN_FG_MS"] !== undefined && Number.isFinite(minFg) ? { toolLimits: { minForegroundMs: minFg } } : {}),
	});
}
