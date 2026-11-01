#!/usr/bin/env node
/**
 * W2 (2026-11-01): THE PACKED WEB APP, INSTALLED THE WAY A PERSON INSTALLS IT.
 *
 * Packs every publishable package from the built tree and installs the tarballs with `npm install -g` into a
 * temporary prefix: the global layout, where kiso-code and kiso-web are siblings in lib/node_modules and the
 * CLI finds the web app beside itself. That is the one resolution case covered here (a project-local install
 * resolves the same way; `npx @vincemakes/kiso-web` is not covered). The tarballs are installed together, so
 * a release's pins resolve from the set itself before anything is published.
 *
 *   A, all 18 packages:  `kiso-web --no-open` serves the page (200) and a connect code signs in;
 *                        `kiso web --no-open` does the same through the CLI; ctrl+C and SIGTERM both stop the
 *                        host; `kiso chat web` and `kiso -p "web ..."` stay what they were (a session, a prompt);
 *                        no build tool (React, vite) is anywhere in the installed tree.
 *   B, without kiso-web: `kiso web` prints the one install line and exits 1.
 *
 * Run after `npm run build` (the page bundle must exist). Zero dependencies; the exit code is the verdict.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { publishablePackages } from "./publishable-packages.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const WEB = "@vincemakes/kiso-web";
const HINT = "kiso web: the web app is not installed — npm i -g @vincemakes/kiso-web";
const TMP = mkdtempSync(join(tmpdir(), "kiso-web-smoke-"));
let failures = 0;
const check = (ok, what) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
	if (!ok) failures += 1;
};

if (!existsSync(join(ROOT, "apps/web/out/renderer/index.html"))) {
	console.error("[web-packed-smoke] the page bundle is missing: run npm run build first");
	process.exit(1);
}

// pack the closure; a derivation that finds fewer than the lockstep is a failed read
const packages = publishablePackages();
check(packages.length === 18 && packages.includes(WEB), `the publishable closure is 18 packages including ${WEB} (found ${packages.length})`);
const packs = join(TMP, "packs");
mkdirSync(packs);
const tarballs = new Map();
for (const name of packages) {
	const file = execFileSync("npm", ["pack", "-w", name, "--pack-destination", packs], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").at(-1);
	tarballs.set(name, join(packs, file));
}

/** `npm install -g` of these tarballs into a fresh prefix; the prefix's bin directory. */
const install = (label, names) => {
	const prefix = join(TMP, label);
	const started = Date.now();
	execFileSync("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", ...names.map((n) => tarballs.get(n))], { stdio: ["ignore", "ignore", "inherit"] });
	console.log(`      installed ${names.length} tarballs into ${label} in ${Math.round((Date.now() - started) / 1000)} s`);
	return { bin: join(prefix, "bin"), lib: join(prefix, "lib", "node_modules") };
};

/** Every directory under the tree whose name is one of these. */
const findDirs = (dir, names, found = []) => {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		if (!e.isDirectory()) continue;
		const path = join(dir, e.name);
		if (names.has(e.name)) found.push(path.slice(TMP.length));
		findDirs(path, names, found);
	}
	return found;
};

// the person's machine, emptied: its own home, no key in the environment (the faux model answers)
const home = join(TMP, "home");
const work = join(TMP, "work");
mkdirSync(home);
mkdirSync(work);
const env = (bin) => {
	const e = { ...process.env, HOME: home, KISO_HOME: join(home, ".kiso"), KISO_WEB_WORKSPACE: work, PATH: `${bin}:${process.env.PATH}` };
	for (const k of Object.keys(e)) if (/(_API_KEY|_BASE_URL|_MODEL)$/.test(k) || k.startsWith("KISO_WEB_") && k !== "KISO_WEB_WORKSPACE") delete e[k];
	return e;
};

/** Start a command that serves the page; resolves with the child and its READY record. */
const serve = (file, args, bin) =>
	new Promise((done, fail) => {
		const child = spawn(file, args, { cwd: work, env: env(bin), stdio: ["ignore", "pipe", "pipe"], detached: true });
		let out = "";
		let err = "";
		const timer = setTimeout(() => (child.kill("SIGKILL"), fail(new Error(`no READY in 30 s\n${out}\n${err}`))), 30_000);
		child.stderr.on("data", (d) => (err += d));
		child.stdout.on("data", (d) => {
			out += d;
			const line = out.split("\n").find((l) => l.startsWith("READY "));
			if (line === undefined) return;
			clearTimeout(timer);
			done({ child, ready: JSON.parse(line.slice(6)), output: () => out + err });
		});
		child.on("error", fail);
	});
const exited = (child) => new Promise((done) => (child.exitCode !== null ? done(child.exitCode) : child.on("exit", (code, signal) => done(code ?? signal))));

/** The page answers, and its connect code signs in. */
const signIn = async (label, ready) => {
	const page = await fetch(`${ready.origin}/`);
	const html = await page.text();
	check(page.status === 200 && /<script[^>]+src="\/assets\//.test(html), `${label}: GET / is 200 and serves the page bundle`);
	const code = new URL(ready.connect).hash.slice(3);
	const traded = await fetch(`${ready.origin}/auth/connect`, { method: "POST", headers: { origin: ready.origin }, body: JSON.stringify({ code }) });
	const cookie = (traded.headers.get("set-cookie") ?? "").split(";")[0];
	const status = await (await fetch(`${ready.origin}/auth/status`, { headers: { cookie } })).json();
	// a desk route, as the page calls it; the session routes need a model, which this empty home has none of
	const desk = (headers) => fetch(`${ready.origin}/desk/env`, { headers: { "sec-fetch-site": "same-origin", ...headers } }).then((r) => r.status);
	const [withCookie, without] = [await desk({ cookie }), await desk({})];
	check(traded.status === 200 && status.signedIn === true && withCookie === 200 && without === 401, `${label}: the connect code signs in (cookie ${cookie.split("=")[0]}); the cookie opens the desk, its absence does not (connect ${traded.status}, desk ${withCookie} / ${without})`);
};

/** Run a command to its end; its exit code and everything it printed. */
const run = (file, args, bin) =>
	new Promise((done) => {
		const child = spawn(file, args, { cwd: work, env: env(bin), stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
		child.on("exit", (code) => (clearTimeout(timer), done({ code, out })));
	});

try {
	// A: the whole set
	const a = install("A", packages);
	const nested = readdirSync(a.lib, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? findDirs(join(a.lib, e.name), new Set(["@vincemakes"])) : []));
	check(existsSync(join(a.bin, "kiso")) && existsSync(join(a.bin, "kiso-web")) && nested.length === 0, `A: both bins installed; every kiso package is a sibling in lib/node_modules (nested copies: ${nested.length})`);
	const tools = findDirs(a.lib, new Set(["react", "react-dom", "vite", "@vitejs"]));
	check(tools.length === 0, `A: no React, react-dom or vite anywhere in the installed tree${tools.length ? ` (${tools.join(", ")})` : ""}`);

	const direct = await serve(join(a.bin, "kiso-web"), ["--no-open", "--port", "0"], a.bin);
	await signIn("kiso-web --no-open", direct.ready);
	process.kill(-direct.child.pid, "SIGINT"); // ctrl+C reaches the whole foreground group
	check((await exited(direct.child)) === 0, "kiso-web: ctrl+C stops the host, exit 0");

	const viaCli = await serve(join(a.bin, "kiso"), ["web", "--no-open", "--port", "0"], a.bin);
	await signIn("kiso web --no-open", viaCli.ready);
	viaCli.child.kill("SIGTERM"); // to kiso alone: it passes the signal on, so no host is left behind
	const code = await exited(viaCli.child);
	const left = await fetch(`${viaCli.ready.origin}/auth/status`).then(() => "still answering", () => "closed");
	check(code === 0 && left === "closed", `kiso web: SIGTERM to kiso stops the host it started (exit ${code}, port ${left})`);

	const chat = await run(join(a.bin, "kiso"), ["chat", "web"], a.bin);
	check(chat.code === 0 && /session web/.test(chat.out) && !/kiso-web/.test(chat.out), "A: `kiso chat web` still opens a session named web");
	const print = await run(join(a.bin, "kiso"), ["-p", "web hello"], a.bin);
	check(print.code === 0 && /you> web hello/.test(print.out) && !/kiso-web/.test(print.out), "A: `kiso -p \"web hello\"` is still a one-shot prompt");

	// B: the terminal alone
	const b = install("B", packages.filter((n) => n !== WEB));
	const hint = await run(join(b.bin, "kiso"), ["web"], b.bin);
	check(hint.code === 1 && hint.out.trim() === HINT, `B: without kiso-web, \`kiso web\` prints the install line and exits 1 (exit ${hint.code}: ${hint.out.trim()})`);
	const hintArgs = await run(join(b.bin, "kiso"), ["web", "--no-open"], b.bin);
	check(hintArgs.code === 1 && hintArgs.out.trim() === HINT, "B: the same with the web app's own flags");
} catch (error) {
	check(false, `the smoke itself failed: ${error instanceof Error ? error.message : error}`);
} finally {
	rmSync(TMP, { recursive: true, force: true });
}
console.log(failures === 0 ? "[web-packed-smoke] OK" : `[web-packed-smoke] FAIL: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
