// Shared by the proofs: the headless host, the Electron app with its debugging port, and the assertions.
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@vincemakes/kiso-client";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const scratch = (label) => mkdtempSync(join(tmpdir(), `kiso-desktop-${label}-`));

export async function waitUntil(pred, ms = 15_000, step = 100) {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(step)) if (await pred()) return true;
	return false;
}

/** Assertions: each prints ok or FAIL; the exit code is the verdict. */
export function checker(name) {
	let failed = 0;
	const check = (ok, label) => {
		console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
		if (!ok) failed += 1;
	};
	const verdict = () => {
		console.log(`RESULT ${name}: ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
		if (failed > 0) process.exitCode = 1;
	};
	return { check, verdict };
}

/** Spawn the headless host; resolves once it printed READY. */
export function launch({ data, workspace, fauxScript, env = {} }) {
	const scriptPath = join(data, "faux.json");
	if (fauxScript !== undefined) writeFileSync(scriptPath, JSON.stringify(fauxScript));
	const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/main/headless.js", import.meta.url))], {
		env: { ...process.env, KISO_DESKTOP_DATA: data, KISO_DESKTOP_WORKSPACE: workspace, ...(fauxScript !== undefined ? { KISO_DESKTOP_FAUX: scriptPath } : {}), ...env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let buf = "";
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.stdout.on("data", (d) => {
			const m = /^READY (.*)$/m.exec((buf += d));
			if (m !== null) resolve({ child, ...JSON.parse(m[1]) });
		});
		child.once("exit", (code) => reject(new Error(`host exited ${code}: ${err}`)));
	});
}

export const clientFor = (host) => createClient({ baseUrl: `${host.origin}/v1/sessions`, headers: () => ({ authorization: `Bearer ${host.token}` }) });

/** The applications named "Electron" that this checkout's binary has registered with macOS (what the Dock lists): pid and type. */
export const electronApps = () =>
	execFileSync("lsappinfo", ["list"], { encoding: "utf8" })
		.split(/^\d+\) /m)
		.filter((b) => b.startsWith('"Electron"') && b.includes(fileURLToPath(new URL("../../../../node_modules/electron/dist/", import.meta.url))))
		.map((b) => ({ pid: Number(/pid = (\d+)/.exec(b)?.[1]), type: /type="(\w+)"/.exec(b)?.[1] }));

/** The Electron app (hidden window) on a faux script, attached to its page over the debugging port. */
export async function launchElectron({ data, workspace, fauxScript, env = {} }) {
	writeFileSync(join(data, "faux.json"), JSON.stringify(fauxScript));
	const debugPort = String(9300 + Math.floor(Math.random() * 600));
	const child = spawn(process.execPath, [createRequire(import.meta.url).resolve("electron/cli.js"), fileURLToPath(new URL("../..", import.meta.url))], {
		env: { ...process.env, KISO_DESKTOP_DATA: data, KISO_DESKTOP_WORKSPACE: workspace, KISO_DESKTOP_FAUX: join(data, "faux.json"), KISO_DESKTOP_DEBUG_PORT: debugPort, KISO_DESKTOP_PROOF: "1", ...env },
		stdio: ["ignore", "pipe", "ignore"],
	});
	const lines = [];
	let ready = null;
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		for (let i; (i = buf.indexOf("\n")) !== -1; buf = buf.slice(i + 1)) {
			lines.push(buf.slice(0, i));
			if (buf.startsWith("READY ")) ready = JSON.parse(buf.slice(6, i));
		}
	});
	if (!(await waitUntil(() => ready !== null, 180_000))) throw new Error(`electron did not become ready:\n${lines.join("\n")}`);
	const page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === "page");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	const pending = new Map();
	let id = 0;
	ws.onmessage = (m) => pending.get(JSON.parse(m.data).id)?.(JSON.parse(m.data));
	const cdp = (method, params) => new Promise((resolve) => (pending.set(++id, (msg) => resolve(msg.result)), ws.send(JSON.stringify({ id, method, params }))));
	const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
	/** A PNG of the window, written outside the repository (KISO_DESKTOP_SHOTS, else the temporary directory). */
	const shot = async (name) => {
		const dir = process.env.KISO_DESKTOP_SHOTS ?? join(tmpdir(), "kiso-desktop-shots");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${name}.png`), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
	};
	// a proof run stays out of the Dock and the focus: whatever the binary registered must be this app, background only
	const close = async () => {
		const apps = electronApps();
		const hidden = apps.every((a) => a.pid === ready.pid && a.type === "BackgroundOnly");
		console.log(`${hidden ? "ok  " : "FAIL"} the proof run is not in the Dock (Electron applications registered: ${JSON.stringify(apps)})`);
		if (!hidden) process.exitCode = 1;
		ws.close();
		child.kill("SIGTERM");
		await new Promise((r) => child.once("exit", r));
	};
	/** The text of the first match, or null. */
	const text = (q) => evaluate(`document.querySelector(${JSON.stringify(q)})?.textContent ?? null`);
	const count = (q) => evaluate(`document.querySelectorAll(${JSON.stringify(q)}).length`);
	const click = (q) => evaluate(`document.querySelector(${JSON.stringify(q)})?.click() ?? false`);
	return { ready, lines, evaluate, shot, close, text, count, click, startupMs: 0 };
}
