import { app, BrowserWindow } from "electron";
import { startFromEnv } from "./env.js";
import type { Host } from "./host.js";

/**
 * The Electron main (spike): it starts the host in this process, opens one
 * window on the host's own page, and forwards the page's console to stdout
 * so a script can see the streamed run. The token rides the URL fragment,
 * which the page reads and removes; it never reaches a server log.
 *
 *   KISO_DESKTOP_SHOW=1             show the window (default: hidden)
 *   KISO_DESKTOP_DEBUG_PORT=<port>  open the remote debugging port
 *   KISO_DESKTOP_AUTORUN=<text>     send this input when the page loads
 *   KISO_DESKTOP_SESSION=<id>       the session the page drives
 */

const debugPort = process.env["KISO_DESKTOP_DEBUG_PORT"];
if (debugPort !== undefined) app.commandLine.appendSwitch("remote-debugging-port", debugPort);

let host: Host | undefined;
let stopping = false;

async function stop(code: number): Promise<void> {
	if (stopping) return;
	stopping = true;
	await host?.close(5_000);
	app.exit(code);
}

app.whenReady().then(async () => {
	host = await startFromEnv();
	const win = new BrowserWindow({
		width: 1100,
		height: 760,
		show: process.env["KISO_DESKTOP_SHOW"] === "1",
		webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
	});
	// the page is ours alone: nothing navigates away, nothing opens another window
	win.webContents.on("will-navigate", (e, url) => {
		if (!url.startsWith(host!.origin)) e.preventDefault();
	});
	win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
	win.webContents.on("console-message", (e) => process.stdout.write(`RENDERER ${e.message}\n`));
	const params = new URLSearchParams({ token: host.token, session: process.env["KISO_DESKTOP_SESSION"] ?? "desktop-spike" });
	const auto = process.env["KISO_DESKTOP_AUTORUN"];
	if (auto !== undefined) params.set("input", auto);
	await win.loadURL(`${host.origin}/#${params.toString()}`);
	process.stdout.write(`READY ${JSON.stringify({ origin: host.origin, pid: process.pid, electron: process.versions.electron, debugPort: debugPort ?? null })}\n`);
});

app.on("window-all-closed", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
