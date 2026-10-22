import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, utilityProcess, type UtilityProcess } from "electron";
import { startFromEnv } from "./env.js";
import type { Host } from "./host.js";

/**
 * The Electron main. The host (session service, loopback listener, frames)
 * runs in a utility process, so a host crash does not take the window
 * with it: the main process starts another one on the same port and token
 * and the page's client reconnects. `KISO_DESKTOP_HOST_IN_MAIN=1` runs the
 * host in this process instead (the fallback).
 *
 *   KISO_DESKTOP_SHOW=1             show the window (default: hidden)
 *   KISO_DESKTOP_DEBUG_PORT=<port>  open the remote debugging port
 *   KISO_DESKTOP_AUTORUN=<text>     send this input when the page loads
 *   KISO_DESKTOP_SESSION=<id>       the session the page drives
 *   KISO_DESKTOP_PROOF=1            a proof run: print the host pid and token on READY, and stay out of the Dock and the focus
 */

// A proof run is not an application the person should see: no Dock icon, no bouncing, no focus, no Cmd-Tab entry.
// (macOS; the window is also created hidden. Normal use is unaffected.)
if (process.env["KISO_DESKTOP_PROOF"] === "1" && process.platform === "darwin") app.setActivationPolicy("prohibited");

const debugPort = process.env["KISO_DESKTOP_DEBUG_PORT"];
if (debugPort !== undefined) app.commandLine.appendSwitch("remote-debugging-port", debugPort);

interface Ready {
	readonly origin: string;
	readonly port: number;
	readonly token: string;
	readonly pid: number;
}

const MAX_RESPAWNS = 5;
const servicePath = fileURLToPath(new URL("./service-process.js", import.meta.url));
const token = randomBytes(32).toString("hex");

let stopping = false;
let child: UtilityProcess | undefined;
let inMain: Host | undefined;
let port = 0;
let respawns = 0;

const say = (line: string): void => void process.stdout.write(`${line}\n`);

/** Fork the host and resolve when it says it listens; resolves null if it failed. */
function forkHost(): Promise<Ready | null> {
	return new Promise((resolve) => {
		const proc = utilityProcess.fork(servicePath, [], {
			serviceName: "kiso host",
			stdio: "pipe",
			env: { ...process.env, KISO_DESKTOP_TOKEN: token, KISO_DESKTOP_PORT: String(port) } as Record<string, string>,
		});
		child = proc;
		proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`HOST ${d}`));
		proc.stderr?.on("data", (d: Buffer) => process.stdout.write(`HOST-ERR ${d}`));
		proc.on("message", (m: { type: string; message?: string } & Partial<Ready>) => {
			if (m.type === "ready") resolve(m as Ready);
			else if (m.type === "failed") {
				say(`HOST_FAILED ${m.message ?? ""}`);
				resolve(null);
			}
		});
		proc.on("exit", (code) => {
			if (child === proc) child = undefined;
			resolve(null);
			if (stopping) return;
			say(`HOST_EXIT ${JSON.stringify({ code })}`);
			if (respawns >= MAX_RESPAWNS) return say("HOST_GIVING_UP");
			respawns += 1;
			// same port and token: the page's client reconnects by itself
			setTimeout(() => {
				void forkHost().then((r) => r !== null && say(`HOST_RESPAWNED ${JSON.stringify({ pid: r.pid, openRuns: (r as { openRuns?: unknown }).openRuns })}`));
			}, 200);
		});
	});
}

async function stop(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	child?.postMessage({ type: "stop" });
	await inMain?.close(5_000);
	// give the host its orderly exit, then go
	await new Promise((r) => setTimeout(r, child === undefined ? 0 : 1_500));
	child?.kill();
	app.exit(code);
}

app.whenReady().then(async () => {
	let ready: Ready;
	if (process.env["KISO_DESKTOP_HOST_IN_MAIN"] === "1") {
		inMain = await startFromEnv();
		ready = { origin: inMain.origin, port: inMain.port, token: inMain.token, pid: process.pid };
	} else {
		const r = await forkHost();
		if (r === null) return void (await stop(1));
		ready = r;
		port = r.port;
	}
	const win = new BrowserWindow({
		width: 1100,
		height: 760,
		show: process.env["KISO_DESKTOP_SHOW"] === "1",
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	// the page is ours alone: nothing navigates away, nothing opens another window
	win.webContents.on("will-navigate", (e, url) => {
		if (!url.startsWith(ready.origin)) e.preventDefault();
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("console-message", (e) => process.stdout.write(`RENDERER ${e.message}\n`));
	const params = new URLSearchParams({ token: ready.token, session: process.env["KISO_DESKTOP_SESSION"] ?? "desktop-spike" });
	const auto = process.env["KISO_DESKTOP_AUTORUN"];
	if (auto !== undefined) params.set("input", auto);
	await win.loadURL(`${ready.origin}/#${params.toString()}`);
	const proof = process.env["KISO_DESKTOP_PROOF"] === "1" ? { hostPid: ready.pid, token: ready.token, port: ready.port } : {};
	say(`READY ${JSON.stringify({ origin: ready.origin, pid: process.pid, electron: process.versions.electron, debugPort: debugPort ?? null, hosting: inMain !== undefined ? "main" : "utility", ...proof })}`);
});

app.on("window-all-closed", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
