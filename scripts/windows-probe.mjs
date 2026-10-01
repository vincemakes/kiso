// Windows P5 — the process module on a real Windows machine (the CI's
// windows-latest runner, which ships Git for Windows). The unit tests pin
// the win32 branches with a scripted child_process on every OS; this probe
// runs them for real: Git Bash runs the command, taskkill takes the tree
// down and confirms it, the CIM query reads a start time, and a KISO_BASH
// naming another program is refused. Run after `npm run build`.
// Exit 0 = every probe passed; exit 1 = at least one failed (each printed).

import { NO_BASH, killTree, processStartTime, startCommand } from "../packages/tools-node/dist/process.js";

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

console.log(failed === 0 ? "[windows-probe] all probes passed" : `[windows-probe] ${failed} probe(s) failed`);
process.exit(failed === 0 ? 0 : 1);
