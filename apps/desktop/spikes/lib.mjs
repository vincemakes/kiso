// Shared helpers for the spike scripts: spawn the headless host, read its
// READY line, build a client against it. Every script prints a transcript.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@vincemakes/kiso-client";

export const HEADLESS = fileURLToPath(new URL("../dist/main/headless.js", import.meta.url));
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
