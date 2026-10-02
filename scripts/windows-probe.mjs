// Windows P5 — the process module, the safety checks' path reading and the small spawns on a real Windows machine (the CI's
// windows-latest runner, which ships Git for Windows). The unit tests pin
// the win32 branches with a scripted child_process on every OS; this probe
// runs them for real: Git Bash runs the command, taskkill takes the tree
// down and confirms it, the CIM query reads a start time, and a KISO_BASH
// naming another program is refused. Run after `npm run build`.
// Exit 0 = every probe passed; exit 1 = at least one failed (each printed).

import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BASH, killTree, processStartTime, startCommand } from "../packages/tools-node/dist/process.js";
import { floorCheck } from "../apps/cli/dist/floor.js";
import { classifyReadOnly } from "../apps/cli/dist/readonly-shell.js";
import { resolveShellPath } from "../apps/cli/dist/shell-words.js";
import { viaCmd } from "../apps/cli/dist/launch.js";
import { spawnSync } from "node:child_process";

if (process.platform !== "win32") {
	console.log("[windows-probe] skipped: not win32");
	process.exit(0);
}

let failed = 0;
const check = (name, ok, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failed += 1;
};

/** Run a command to completion; its exit code and combined output. */
function run(command) {
	return new Promise((resolve) => {
		const child = startCommand(command, { cwd: process.cwd(), env: process.env });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("error", (err) => resolve({ code: null, out: String(err) }));
		child.on("close", (code) => resolve({ code, out }));
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. The command runs through Git Bash, POSIX syntax and all.
{
	const r = await run('echo "hi from $0"; uname -s; x=1; [ "$x" = 1 ] && echo posix-ok');
	check("startCommand runs POSIX shell syntax through Git Bash", r.code === 0 && /hi from/.test(r.out) && /posix-ok/.test(r.out) && /MINGW|MSYS/i.test(r.out), JSON.stringify(r.out.trim()));
}

// 2. cmd syntax is not interpreted: %VAR% stays literal under bash.
{
	const r = await run("echo %USERPROFILE%");
	check("cmd syntax stays literal (%USERPROFILE% is not expanded)", r.code === 0 && r.out.trim() === "%USERPROFILE%", JSON.stringify(r.out.trim()));
}

// 3. A process's start time: running for itself, gone for an exited pid.
{
	const self = processStartTime(process.pid);
	check("processStartTime(self) is running with an ISO time", self.kind === "running" && /^\d{4}-\d\d-\d\dT/.test(self.startedAt), JSON.stringify(self));
	const child = startCommand("exit 0", { cwd: process.cwd(), env: process.env });
	const pid = child.pid;
	await new Promise((r) => child.on("close", r));
	await sleep(500);
	const gone = processStartTime(pid);
	check("processStartTime(an exited pid) is gone, not unknown", gone.kind === "gone", JSON.stringify(gone));
}

// 4. killTree takes a running tree down — the root and a grandchild — and confirms it.
{
	const child = startCommand("sleep 60 & sleep 60; wait", { cwd: process.cwd(), env: process.env });
	await sleep(1500);
	const rootBefore = processStartTime(child.pid);
	const t0 = Date.now();
	const verdict = await killTree(child);
	const rootAfter = processStartTime(child.pid);
	check("killTree confirms the tree is gone", verdict.unconfirmed.length === 0, `${JSON.stringify(verdict)} in ${Date.now() - t0} ms`);
	check("the root was running before and is gone after", rootBefore.kind === "running" && rootAfter.kind === "gone", `${rootBefore.kind} -> ${rootAfter.kind}`);
}

// 5. KISO_BASH naming another program is refused, coded NO_BASH.
{
	const saved = process.env.KISO_BASH;
	process.env.KISO_BASH = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
	let code;
	try {
		startCommand("echo no", { cwd: process.cwd(), env: process.env });
	} catch (err) {
		code = err.code;
	}
	if (saved === undefined) delete process.env.KISO_BASH;
	else process.env.KISO_BASH = saved;
	check("KISO_BASH naming PowerShell is refused (KISO_NO_BASH)", code === NO_BASH, String(code));
}

// ── P2: the safety checks' path reading on a real Windows disk ─────────
const base = realpathSync.native(mkdtempSync(join(tmpdir(), "kiso-probe-")));
const ws = join(base, "ws");
const outside = join(base, "outside");
mkdirSync(join(ws, "Src"), { recursive: true });
mkdirSync(outside, { recursive: true });
writeFileSync(join(ws, "Src", "a.ts"), "x");
writeFileSync(join(outside, "secret.txt"), "s");

// 6. the disk is case-insensitive, and the checks read it so
{
	const r = resolveShellPath(ws, ws, "SRC/A.TS");
	check("a path in another case is the file, inside", r.inside && r.canonical === join(ws, "Src", "a.ts"), JSON.stringify(r));
	check("the read-only allow runs `cat SRC/A.TS` unasked", classifyReadOnly("cat SRC/A.TS", ws).allow === true);
}

// 7. a junction out of the workspace (the Windows twin of a symlink escape)
{
	let made = true;
	try {
		symlinkSync(outside, join(ws, "jn"), "junction");
	} catch (err) {
		made = false;
		console.log(`SKIP junction probes — could not create one: ${err.message}`);
	}
	if (made) {
		const through = resolveShellPath(ws, ws, "jn/secret.txt");
		check("a path through a junction is where the junction points: outside", !through.inside && through.canonical === join(outside, "secret.txt"), JSON.stringify(through));
		check("the read-only allow asks for `cat jn/secret.txt`", classifyReadOnly("cat jn/secret.txt", ws).allow === false);
		const back = resolveShellPath(ws, ws, "jn/..");
		check("`jn/..` — Win32's textual `..` and the real-path one land apart: opaque", back.opaque !== undefined, JSON.stringify(back));
		check("the floor refuses `rm -rf jn/..`", floorCheck("rm -rf jn/..", ws, base).refused === true);
	}
}

// 8. an existing 8.3 short name is expanded (when the volume keeps them)
{
	let long;
	try {
		long = realpathSync.native("C:\\PROGRA~1");
	} catch {
		long = undefined;
	}
	if (long === undefined) console.log("SKIP short-name probe — C:\\PROGRA~1 does not exist on this volume");
	else {
		const r = resolveShellPath(ws, ws, "C:/PROGRA~1");
		check("C:/PROGRA~1 reads as the directory it names", r.canonical.toLowerCase() === long.toLowerCase() && r.opaque === undefined, `${JSON.stringify(r)} vs ${long}`);
		check("the floor refuses `rm -rf C:/PROGRA~1`", floorCheck("rm -rf C:/PROGRA~1", ws, base).refused === true);
	}
}

// ── P3: the small spawns through cmd.exe ─────────────────────────────────
/** What a program started by viaCmd receives as its arguments. */
const received = (bin, args) => {
	const l = viaCmd(bin, args);
	const r = spawnSync(l.file, l.args, { encoding: "utf8", windowsVerbatimArguments: true });
	try {
		return JSON.parse(r.stdout.trim().split("\n").at(-1));
	} catch {
		return { stdout: r.stdout, stderr: r.stderr, status: r.status };
	}
};

// 9. an executable gets every argument exactly, metacharacters and all
{
	const args = ["a b", "x&y", "c^d", "50%PATH%", "(z)", 'say "hi"', "C:\\dir\\", "a|b<c>d", "!bang!", "semi;colon,comma"];
	const got = received(process.execPath, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", ...args]);
	check("viaCmd hands an executable every argument exactly", JSON.stringify(got) === JSON.stringify(args), JSON.stringify(got));
}

// 10. a .cmd shim in a directory with spaces, & and parentheses gets a
// path with the same (the editor's case: code.cmd and the draft's path)
{
	const dir = join(base, "dir with space & (x)");
	mkdirSync(dir, { recursive: true });
	const shim = join(dir, "echoargs.cmd");
	writeFileSync(shim, `@"${process.execPath}" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n`);
	const draft = join(dir, "message.md");
	const got = received(shim, [draft]);
	check("viaCmd starts a .cmd shim from a path with spaces, & and ( ), and it gets the draft's path", JSON.stringify(got) === JSON.stringify([draft]), JSON.stringify(got));
}

console.log(failed === 0 ? "[windows-probe] all probes passed" : `[windows-probe] ${failed} probe(s) failed`);
process.exit(failed === 0 ? 0 : 1);
