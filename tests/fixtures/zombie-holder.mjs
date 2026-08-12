#!/usr/bin/env node
/**
 * Produce a GUARANTEED zombie and hold it unreaped (R-I-p, Finding R-I-1).
 *
 * A child is spawned and exits while THIS process's event loop is blocked:
 * libuv's SIGCHLD watcher cannot run, so the exited child is never reaped
 * — it is a genuine, persistent zombie (STAT Z), and `kill(pid, 0)` still
 * reports it alive (POSIX: it exists until reaped). That false positive is
 * the finding: the ADR-0050 takeover judged the dead holder "live foreign"
 * and refused the resume.
 *
 * The holder identity is written to the pid file, then the fixture blocks
 * forever (Atomics.wait — the event loop must never run, or the zombie
 * would be reaped) until the test SIGKILLs it. The zombie is this
 * fixture's CHILD — a test that spawns the fixture could never reap the
 * zombie itself (waitpid only reaps direct children, and the fixture holds
 * it) — the un-reaped dead-holder shape of the npx-launched CLI.
 *
 * Usage: node zombie-holder.mjs <pid-file>
 */
import { spawn, execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [pidFile] = process.argv.slice(2);
const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
// Busy-spin: the event loop never runs, the exited child is never reaped.
const end = Date.now() + 1200;
while (Date.now() < end) {
	/* spin — no event loop */
}
const state = execFileSync("ps", ["-o", "state=", "-p", String(child.pid)], { encoding: "utf8" }).trim();
writeFileSync(pidFile, JSON.stringify({ pid: child.pid, state }));
if (!state.includes("Z")) process.exit(2); // the tests assert the precondition
// Hold the zombie forever — the event loop must never run again.
const buf = new Int32Array(new SharedArrayBuffer(4));
Atomics.wait(buf, 0, 0);
