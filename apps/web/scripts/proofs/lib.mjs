// Shared by the proofs: the host (`kiso-web`), a headless Chrome on its page over the DevTools protocol, and the assertions.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@vincemakes/kiso-client";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const scratch = (label) => mkdtempSync(join(tmpdir(), `kiso-web-${label}-`));

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

/** Spawn the host (`kiso-web --no-open`, port 0 unless KISO_WEB_PORT names one); resolves once it printed READY. The scripts' bearer
 *  token is the proof's own (the host never prints one). */
export function launch({ data, workspace, fauxScript, env = {} }) {
	const scriptPath = join(data, "faux.json");
	if (fauxScript !== undefined) writeFileSync(scriptPath, JSON.stringify(fauxScript));
	const token = env.KISO_WEB_TOKEN ?? randomBytes(16).toString("hex");
	const child = spawn(process.execPath, [fileURLToPath(new URL("../../dist/main/headless.js", import.meta.url)), "--no-open", "--port", env.KISO_WEB_PORT ?? "0"], {
		env: { ...process.env, KISO_HOME: data, KISO_WEB_DATA: data, KISO_WEB_WORKSPACE: workspace, ...(fauxScript !== undefined ? { KISO_WEB_FAUX: scriptPath } : {}), ...env, KISO_WEB_TOKEN: token },
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let buf = "";
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.stdout.on("data", (d) => {
			const m = /^READY (.*)$/m.exec((buf += d));
			if (m !== null) resolve({ child, token, ...JSON.parse(m[1]) });
		});
		child.once("exit", (code) => reject(new Error(`host exited ${code}: ${err}`)));
	});
}

export const clientFor = (host) => createClient({ baseUrl: `${host.origin}/v1/sessions`, headers: () => ({ authorization: `Bearer ${host.token}` }) });

/** Chrome: KISO_WEB_CHROME, else the usual places on macOS and Linux. */
function chromePath() {
	if (process.env.KISO_WEB_CHROME) return process.env.KISO_WEB_CHROME;
	const mac = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"].find((p) => existsSync(p));
	if (mac !== undefined) return mac;
	for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) try { return execFileSync("which", [name], { encoding: "utf8" }).trim(); } catch { /* next */ }
	throw new Error("no Chrome found: set KISO_WEB_CHROME");
}

/** A headless Chrome with its own profile (its cookies are this browser's alone), reached over the DevTools protocol. */
export async function startChrome() {
	const profile = scratch("chrome");
	const child = spawn(chromePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1100,760", "--disable-gpu", ...(process.env.CI === "true" ? ["--no-sandbox"] : []), "about:blank"], { stdio: "ignore" });
	const portFile = join(profile, "DevToolsActivePort");
	if (!(await waitUntil(() => existsSync(portFile) && readFileSync(portFile, "utf8").includes("\n"), 30_000))) throw new Error("Chrome did not open its debugging port");
	const port = Number(readFileSync(portFile, "utf8").split("\n")[0]);
	const http = (path) => fetch(`http://127.0.0.1:${port}${path}`, { method: "PUT" }).then((r) => r.json());
	/** A new tab on `url`, driven through its own socket. */
	const open = async (url) => {
		const target = await http(`/json/new?${encodeURIComponent(url)}`);
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((r) => (ws.onopen = r));
		const pending = new Map();
		let id = 0;
		ws.onmessage = (m) => pending.get(JSON.parse(m.data).id)?.(JSON.parse(m.data));
		const cdp = (method, params) => new Promise((resolve) => (pending.set(++id, (msg) => resolve(msg.result)), ws.send(JSON.stringify({ id, method, params }))));
		const evaluate = async (expression) => (await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }))?.result?.value;
		/** A PNG of the tab, written outside the repository (KISO_WEB_SHOTS, else the temporary directory). */
		const shot = async (name) => {
			const dir = process.env.KISO_WEB_SHOTS ?? join(tmpdir(), "kiso-web-shots");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${name}.png`), Buffer.from((await cdp("Page.captureScreenshot", { format: "png" })).data, "base64"));
		};
		const text = (q) => evaluate(`document.querySelector(${JSON.stringify(q)})?.textContent ?? null`);
		const count = (q) => evaluate(`document.querySelectorAll(${JSON.stringify(q)}).length`);
		const click = (q) => evaluate(`document.querySelector(${JSON.stringify(q)})?.click() ?? false`);
		const close = async () => (ws.close(), await http(`/json/close/${target.id}`).catch(() => undefined));
		// a tab behind another draws nothing (no animation frames): bring it to the front to look at it
		const front = () => cdp("Page.bringToFront");
		// signed in and the Work opened, or signed out
		await waitUntil(() => evaluate("window.__kiso !== undefined || document.querySelector('[data-kind=signedout]') !== null").catch(() => false), 30_000);
		return { evaluate, shot, text, count, click, cdp, close, front };
	};
	const close = async () => {
		child.kill("SIGTERM");
		await new Promise((r) => (child.exitCode !== null ? r() : child.once("exit", r)));
	};
	return { open, close, port };
}

/** The address a host's page opens on: its one-time connect code, the session the page drives (KISO_WEB_SESSION) and an input it sends (KISO_WEB_AUTORUN). */
export const pageUrl = (host, { session, input } = {}) => {
	const params = new URLSearchParams(new URL(host.connect).hash.slice(1));
	if (session !== undefined) params.set("session", session);
	if (input !== undefined) params.set("input", input);
	return `${host.origin}/#${params.toString()}`;
};

/** The host on a faux script and one Chrome tab on its page, signed in by the connect code. `restart()` kills the host with SIGKILL
 *  (by pid) and starts another on the same port and token, as a person would run the command again; the tab stays. */
export async function launchApp({ data, workspace, fauxScript, env = {} }) {
	const { KISO_WEB_SESSION: session, KISO_WEB_AUTORUN: input, ...hostEnv } = env;
	let host = await launch({ data, workspace, fauxScript, env: hostEnv });
	const chrome = await startChrome();
	const page = await chrome.open(pageUrl(host, { session, input }));
	const restart = async (extra = {}) => {
		process.kill(host.pid, "SIGKILL");
		await new Promise((r) => (host.child.exitCode !== null ? r() : host.child.once("exit", r)));
		host = await launch({ data, workspace, fauxScript, env: { ...hostEnv, ...extra, KISO_WEB_PORT: String(host.port), KISO_WEB_TOKEN: host.token } });
		return host;
	};
	const close = async () => {
		await page.close();
		await chrome.close();
		host.child.kill("SIGTERM");
		await new Promise((r) => (host.child.exitCode !== null ? r() : host.child.once("exit", r)));
	};
	return { ...page, closeTab: page.close, host: () => host, chrome, restart, close };
}
