// Shared helpers for the spike scripts: spawn the headless host, read its
// READY line, build a client against it. Every script prints a transcript.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@vincemakes/kiso-client";

export const HEADLESS = fileURLToPath(new URL("../../dist/main/headless.js", import.meta.url));
export const EVIDENCE = process.env.DESKTOP_S0_EVIDENCE ?? join(process.env.HOME, "kiso-worktrees", "desktop-s0-evidence");
mkdirSync(EVIDENCE, { recursive: true });

export function scratch(label) {
	return mkdtempSync(join(tmpdir(), `kiso-desktop-${label}-`));
}

/** A transcript: prints and appends to EVIDENCE/<name>.txt. */
export function transcript(name) {
	const file = join(EVIDENCE, `${name}.txt`);
	writeFileSync(file, "");
	return (line = "") => {
		console.log(line);
		appendFileSync(file, `${line}\n`);
	};
}

/** Spawn the headless host; resolves once it printed READY. */
export function launch({ data, workspace, fauxScript, env = {}, fauxSkip }) {
	const scriptPath = join(data, "faux.json");
	if (fauxScript !== undefined) writeFileSync(scriptPath, JSON.stringify(fauxScript));
	const child = spawn(process.execPath, [HEADLESS], {
		env: {
			...process.env,
			KISO_DESKTOP_DATA: data,
			KISO_DESKTOP_WORKSPACE: workspace,
			...(fauxScript !== undefined ? { KISO_DESKTOP_FAUX: scriptPath } : {}),
			...(fauxSkip !== undefined ? { KISO_DESKTOP_FAUX_SKIP: fauxSkip } : {}),
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise((resolve, reject) => {
		let buf = "";
		let err = "";
		child.stderr.on("data", (d) => (err += d));
		child.stdout.on("data", (d) => {
			buf += d;
			const m = /^READY (.*)$/m.exec(buf);
			if (m !== null) resolve({ child, ...JSON.parse(m[1]) });
		});
		child.once("exit", (code) => reject(new Error(`host exited ${code}: ${err}`)));
	});
}

export function clientFor(host) {
	return createClient({ baseUrl: `${host.origin}/v1/sessions`, headers: () => ({ authorization: `Bearer ${host.token}` }) });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A proof's assertions: each prints ok or FAIL; the script's exit code is the verdict. */
export function checker(out) {
	let failed = 0;
	const check = (ok, label) => {
		out(`${ok ? "ok  " : "FAIL"} ${label}`);
		if (!ok) failed += 1;
	};
	const verdict = (name) => {
		out(`RESULT ${name}: ${failed === 0 ? "PASS" : `FAIL (${failed})`}`);
		if (failed > 0) process.exitCode = 1;
	};
	return { check, verdict };
}

/**
 * Launch the Electron app (hidden window) on a faux script and attach to its
 * page over the remote debugging port. Returns what a proof needs: the READY
 * record, every stdout line, `evaluate` in the page, and `close`.
 */
export async function launchElectron({ data, workspace, fauxScript, env = {} }) {
	const { createRequire } = await import("node:module");
	const electronCli = createRequire(import.meta.url).resolve("electron/cli.js");
	const appDir = fileURLToPath(new URL("../..", import.meta.url));
	writeFileSync(join(data, "faux.json"), JSON.stringify(fauxScript));
	const debugPort = String(9300 + Math.floor(Math.random() * 600));
	const child = spawn(process.execPath, [electronCli, appDir], {
		env: {
			...process.env,
			electron_config_cache: process.env.electron_config_cache ?? join(process.env.HOME, "Library", "Caches", "electron"),
			KISO_DESKTOP_DATA: data,
			KISO_DESKTOP_WORKSPACE: workspace,
			KISO_DESKTOP_FAUX: join(data, "faux.json"),
			KISO_DESKTOP_DEBUG_PORT: debugPort,
			KISO_DESKTOP_PROOF: "1",
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const lines = [];
	let ready = null;
	let buf = "";
	child.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			lines.push(line);
			if (line.startsWith("READY ")) ready = JSON.parse(line.slice(6));
		}
	});
	child.stderr.on("data", () => {});
	const t0 = Date.now();
	while (ready === null && Date.now() - t0 < 180_000) await sleep(100);
	if (ready === null) throw new Error(`electron did not become ready:\n${lines.join("\n")}`);
	const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
	const page = targets.find((t) => t.type === "page");
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let id = 0;
	const pending = new Map();
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		pending.get(msg.id)?.(msg);
	};
	const evaluate = (expression) =>
		new Promise((resolve) => {
			const n = ++id;
			pending.set(n, (msg) => resolve(msg.result?.result?.value));
			ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
		});
	const close = async () => {
		ws.close();
		child.kill("SIGTERM");
		await new Promise((r) => child.once("exit", r));
	};
	return { child, ready, lines, evaluate, close, page, startupMs: Date.now() - t0 };
}

export async function waitUntil(pred, ms = 15_000, step = 100) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await pred()) return true;
		await sleep(step);
	}
	return false;
}
