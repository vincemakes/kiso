#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kisoHome } from "@vincemakes/kiso-runtime";
import { revokeSessions } from "./auth.js";
import { startFromEnv } from "./env.js";

/**
 * `kiso-web [--port 4317] [--no-open] [--revoke-sessions]`: the host in this process, the page at http://127.0.0.1:<port>, and the
 * default browser opened once on `#c=<one-time connect code>`. The port is fixed (a page added to the Dock keeps its address): if
 * another kiso-web host holds it, the browser is opened on that host; anything else holding it is an error that names the process.
 * The server runs while the command runs. Configuration beyond the flags: env.ts. It prints `READY {json}` once it listens (the proofs
 * read it); with `--no-open` it also prints the address to open, whose code is good once, for two minutes.
 */

const DEFAULT_PORT = 4317;
const USAGE = "usage: kiso-web [--port <n>] [--no-open] [--revoke-sessions]";

const say = (line: string): void => void process.stdout.write(`${line}\n`);
const fail = (line: string): never => {
	process.stderr.write(`kiso-web: ${line}\n`);
	process.exit(1);
};

function parseArgs(argv: readonly string[]): { readonly port: number; readonly open: boolean; readonly revoke: boolean } {
	let port = Number(process.env["KISO_WEB_PORT"] || DEFAULT_PORT);
	let open = true;
	let revoke = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--no-open") open = false;
		else if (arg === "--revoke-sessions") revoke = true;
		else if (arg === "--port" || arg.startsWith("--port=")) port = Number(arg.includes("=") ? arg.slice(7) : argv[++i]);
		else if (arg === "--help" || arg === "-h") (say(USAGE), process.exit(0));
		else fail(`unknown argument ${arg}\n${USAGE}`);
	}
	if (!Number.isInteger(port) || port < 0 || port > 65_535) fail(`--port must be a port number\n${USAGE}`);
	return { port, open, revoke };
}

/** Where a running host leaves its scripts' token for another `kiso-web` on the same port (mode 0600, removed on exit). */
const hostFile = (home: string, port: number): string => join(home, `web-host-${port}.json`);

/** Who answers on the port: a kiso-web host, something else, or nobody. */
async function probe(port: number): Promise<"kiso-web" | "other" | "free"> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/auth/status`, { signal: AbortSignal.timeout(1_500) });
		return ((await r.json().catch(() => ({}))) as { app?: string }).app === "kiso-web" ? "kiso-web" : "other";
	} catch (error) {
		const code = (error as { cause?: { code?: string } }).cause?.code;
		return code === "ECONNREFUSED" ? "free" : "other";
	}
}

/** The process listening on the port, in words, for the error. */
function holder(port: number): string {
	try {
		const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
		const pid = /^p(\d+)$/m.exec(out)?.[1];
		const command = /^c(.+)$/m.exec(out)?.[1];
		if (pid !== undefined) return `${command ?? "a process"} (pid ${pid})`;
	} catch {
		// no lsof, or nothing found
	}
	return "another program";
}

function openBrowser(url: string): void {
	const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	const child = spawn(cmd, args, { stdio: "ignore", detached: true });
	child.on("error", () => say(`Open ${url} in your browser.`));
	child.unref();
}

/** A connect address from the host already on the port, by the token it left; without one, the bare address (a browser signed in before still is). */
async function addressFrom(home: string, port: number): Promise<string> {
	const origin = `http://127.0.0.1:${port}`;
	try {
		const { token } = JSON.parse(readFileSync(hostFile(home, port), "utf8")) as { token: string };
		const r = await fetch(`${origin}/auth/code`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
		if (r.ok) return `${origin}/#c=${((await r.json()) as { code: string }).code}`;
	} catch {
		// fall through
	}
	return `${origin}/`;
}

async function main(): Promise<void> {
	const { port, open, revoke } = parseArgs(process.argv.slice(2));
	const home = process.env["KISO_WEB_DATA"] ?? kisoHome();
	if (revoke) return say(`kiso-web: ${revokeSessions(home)} session(s) revoked; each browser signs in again from kiso web.`);
	if (port !== 0) {
		const found = await probe(port);
		if (found === "kiso-web") {
			const url = await addressFrom(home, port);
			if (open) openBrowser(url);
			return say(`kiso web is already running at http://127.0.0.1:${port}${open ? "; opened it in your browser" : `; open ${url}`}.`);
		}
		if (found === "other") fail(`port ${port} is held by ${holder(port)}. Stop it, or start kiso web on another port with --port.`);
	}
	const host = await startFromEnv({ port }).catch((error: unknown) =>
		(error as { code?: string }).code === "EADDRINUSE" ? fail(`port ${port} is held by ${holder(port)}. Stop it, or start kiso web on another port with --port.`) : Promise.reject(error),
	);
	const record = hostFile(home, host.port);
	writeFileSync(record, JSON.stringify({ pid: process.pid, token: host.token }), { mode: 0o600 });
	chmodSync(record, 0o600);
	const url = `${host.origin}/#c=${host.connectCode()}`;
	process.stdout.write(`READY ${JSON.stringify({ origin: host.origin, port: host.port, pid: process.pid, openRuns: host.service.openRuns(), ...(open ? {} : { connect: url }) })}\n`);
	say(`kiso web is running at ${host.origin} (Ctrl-C stops it).`);
	if (open) openBrowser(url);
	else say(`Open ${url} (the code in it works once, for two minutes).`);
	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		rmSync(record, { force: true });
		void host.close(5_000).then(() => process.exit(0));
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
