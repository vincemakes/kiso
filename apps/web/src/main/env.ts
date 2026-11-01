import { appendFileSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { canonicalPath, projectDirFor } from "@vincemakes/kiso-code/config";
import { kisoHome } from "@vincemakes/kiso-runtime";
import { fauxSkip } from "./faux.js";
import { startHost, type Host } from "./host.js";
import type { ModelChoice, PermissionMode } from "./agent.js";
import { Settings } from "./settings.js";
import type { Notice } from "./approvals.js";

/**
 * The host's configuration from the environment (the `kiso-web` command
 * reads its flags in headless.ts), so a credential never rides argv:
 *
 *   KISO_WEB_DATA        the kiso home: `projects/<enc>/` under it holds the Works (default: the terminal's own home)
 *   KISO_WEB_WORKSPACE   the folder a new task starts in (default: the folder used last, else the working directory)
 *   KISO_WEB_FAUX        path to a JSON FauxScript (the keyless model)
 *   KISO_WEB_FAUX_SKIP   a session id: skip the script turns its log already consumed
 *   KISO_WEB_MODE        the permission tier: default | accept-edits | plan | full-access
 *   KISO_WEB_NOTIFY_LOG  a file: notices (an approval waits, a run ended) are also appended to it, as JSON lines (the proofs)
 *   KISO_WEB_REQUEST_LOG, KISO_WEB_PREVIEW_LOG  files: each request the host, or a preview server, received (the proofs)
 *   KISO_WEB_SANITIZER   "default" | "web"
 *   KISO_WEB_THINKING    0: leave reasoning text off the wire (default: on)
 *   KISO_WEB_KEEPALIVE   keepalive period in ms
 *   KISO_WEB_MIN_FG_MS   the shell's least foreground wait (0 keeps the model's value)
 *   KISO_WEB_PORT        the port (default 4317; 0: the system picks), and KISO_WEB_TOKEN the scripts' bearer
 *                            token (default: a fresh one per launch, never printed) — the crash script restarts
 *                            the host where a live client expects it
 *
 */

/** A scripted model, for the proofs; otherwise null: the model comes from the shared configuration (settings.ts). */
async function fauxFromEnv(sessionsDir: string): Promise<ModelChoice | null> {
	const fauxPath = process.env["KISO_WEB_FAUX"];
	if (fauxPath === undefined || fauxPath === "") return null;
	const { createFauxProvider } = await import("@vincemakes/kiso-evals");
	const script = JSON.parse(readFileSync(fauxPath, "utf8")) as Parameters<typeof createFauxProvider>[0];
	const skipFor = process.env["KISO_WEB_FAUX_SKIP"];
	const skip = skipFor === undefined || skipFor === "" ? 0 : fauxSkip(sessionsDir, skipFor);
	return { kind: "adapter", adapter: createFauxProvider(script.slice(skip)), model: "faux", route: "adapter" };
}

const MODES: readonly PermissionMode[] = ["default", "accept-edits", "plan", "full-access"];

function modeFromEnv(): PermissionMode {
	const raw = process.env["KISO_WEB_MODE"];
	if (raw === undefined || raw === "") return "default";
	const mode = MODES.find((m) => m === raw);
	if (mode === undefined) throw new Error(`KISO_WEB_MODE must be one of ${MODES.join(", ")}`);
	return mode;
}

const isFolder = (path: string): boolean => {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
};

/** The folder a new task starts in: named by the environment, else the one used last while it still exists, else where the command was started. */
function workspaceFor(settings: Settings): string {
	const named = process.env["KISO_WEB_WORKSPACE"];
	if (named !== undefined && named !== "") return named;
	// a remembered folder can be gone (a deleted scratch folder); "/" is never a place to work: both fall back to the home folder
	const last = settings.lastFolder();
	if (last !== undefined && isFolder(last)) return last;
	const cwd = process.cwd();
	return cwd === "/" || last !== undefined ? homedir() : cwd;
}

/** A copy of every notice in a file, for the proofs. */
function noticeLog(): ((n: Notice) => void) | undefined {
	const log = process.env["KISO_WEB_NOTIFY_LOG"];
	return log === undefined || log === "" ? undefined : (n) => appendFileSync(log, `${JSON.stringify(n)}\n`);
}

export async function startFromEnv(options: { readonly port?: number } = {}): Promise<Host> {
	const home = process.env["KISO_WEB_DATA"] ?? kisoHome();
	// the terminal's configuration and sign-in are read from the one root the terminal uses
	process.env["KISO_HOME"] ??= home;
	const keepalive = Number(process.env["KISO_WEB_KEEPALIVE"] ?? "");
	const minFg = Number(process.env["KISO_WEB_MIN_FG_MS"] ?? "");
	// settings first: its saved tier and folder memory are read before anything is opened
	const probe = new Settings(home, null, modeFromEnv());
	const workspace = canonicalPath(workspaceFor(probe));
	const faux = await fauxFromEnv(projectDirFor(home, workspace));
	const settings = faux === null ? probe : new Settings(home, faux, modeFromEnv());
	// the folder used last is only ever one the person chose (POST /desk/folder): a folder named by the environment, a proof's or a
	// scratch run's, is not remembered for them
	return startHost({
		home,
		workspace,
		settings,
		...(noticeLog() !== undefined ? { notify: noticeLog()! } : {}),
		exposeThinking: process.env["KISO_WEB_THINKING"] !== "0",
		requestLog: process.env["KISO_WEB_REQUEST_LOG"] || undefined,
		previewLog: process.env["KISO_WEB_PREVIEW_LOG"] || undefined,
		...(options.port !== undefined ? { port: options.port } : {}),
		...(process.env["KISO_WEB_TOKEN"] !== undefined ? { token: process.env["KISO_WEB_TOKEN"] } : {}),
		sanitizer: process.env["KISO_WEB_SANITIZER"] === "default" ? "default" : "web",
		...(Number.isFinite(keepalive) && keepalive > 0 ? { keepaliveMs: keepalive } : {}),
		...(process.env["KISO_WEB_MIN_FG_MS"] !== undefined && Number.isFinite(minFg) ? { toolLimits: { minForegroundMs: minFg } } : {}),
	});
}
