/**
 * How a command starts, how a process tree dies, and a process's start
 * time — the one place the shell tool and the task runner (ADR-0058) both
 * stand on. The Windows line adds its win32 branches here, behind the same
 * contracts; everything below is the POSIX path.
 */

import { type ChildProcess, execFileSync, spawn, type StdioOptions } from "node:child_process";
import { closeSync, openSync, renameSync, writeSync } from "node:fs";

/** Children whose output has closed — the shell tool's `exited`, kept here
 *  so `killTree` reads the same moment the tool always did. */
const closed = new WeakSet<ChildProcess>();

/**
 * Start `command` through the shell. `detached`: the command gets its OWN
 * process group, so a stop can kill the WHOLE TREE (children included), not
 * just the outer shell (Area 4).
 */
export function startCommand(
	command: string,
	opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly stdio?: StdioOptions },
): ChildProcess {
	const child = spawn(command, {
		shell: true,
		detached: true,
		cwd: opts.cwd,
		stdio: opts.stdio ?? ["ignore", "pipe", "pipe"],
		env: opts.env,
	});
	child.once("close", () => closed.add(child));
	return child;
}

/**
 * Kill the whole tree and CONFIRM it exited (rounds 8/11):
 *
 * 1. FREEZE the root (SIGSTOP) FIRST — a stopped shell cannot fork new
 *    descendants while we enumerate;
 * 2. repeatedly discover AND freeze descendants (pid-table sweep — the only
 *    way to see a setsid()-escaped process) until the set is STABLE (two
 *    identical scans), so the enumeration cannot miss a mid-sweep fork;
 * 3. SIGKILL the process group and every tracked pid;
 * 4. poll every tracked pid to death. Any tracked pid still alive at the
 *    deadline comes back in `unconfirmed`: the caller must not report the
 *    tree gone — the side effect may have outlived the stop.
 *
 * `graceMs` (ADR-0058, a task's stop): first send SIGTERM to the group and
 * to every descendant seen now, and give the root that long to exit — a
 * server cleans up — then run the same sweep on whatever is left. The
 * descendants seen before the TERM stay tracked, so a child reparented when
 * its parent exits is still found.
 */
export function killTree(child: ChildProcess, opts: { readonly graceMs?: number } = {}): Promise<{ unconfirmed: number[] }> {
	const grace = opts.graceMs ?? 0;
	const pid = child.pid;
	if (grace <= 0 || pid === undefined || pid <= 0 || closed.has(child) || child.exitCode !== null || child.signalCode !== null) {
		return sweep(child, new Set());
	}
	const seen = new Set(descendantsOf(pid));
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		// the group is already gone
	}
	for (const p of seen) {
		try {
			process.kill(p, "SIGTERM");
		} catch {
			// already gone
		}
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(sweep(child, seen)), grace);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve(sweep(child, seen));
		});
	});
}

function sweep(child: ChildProcess, seen: ReadonlySet<number>): Promise<{ unconfirmed: number[] }> {
	return new Promise((resolveKill) => {
		const tracked = new Set<number>(seen);
		// round 11 (adversarial): the ROOT itself is tracked too — the
		// verdict must not read "aborted" while the root survives.
		// DOCUMENTED LIMITS: (1) a process that forks between SIGSTOP
		// delivery and the next scan, setsids, and is then reparented when
		// its parent is killed can escape the enumeration entirely — it is
		// untracked and unknowable from the pid table; the platform cannot
		// confirm it. (2) if THIS process is killed between the first
		// SIGSTOP and the SIGKILL sweep, the stopped descendants stay
		// permanently stopped (nobody SIGCONTs orphans) — the inherent cost
		// of freeze-first. Both limits are recorded here so no claim of "the
		// whole tree is gone" is ever stronger than what the platform can
		// prove.
		if (child.pid !== undefined && child.pid > 0) {
			tracked.add(child.pid);
			try {
				process.kill(child.pid, "SIGSTOP"); // freeze the root
			} catch {
				// already gone
			}
		}
		for (const pid of seen) {
			try {
				process.kill(pid, "SIGSTOP");
			} catch {
				// already gone
			}
		}
		// Stable discovery: freeze as we go; stop when two consecutive scans
		// are identical.
		let previous = new Set<number>();
		for (let i = 0; i < 10; i++) {
			const current = new Set(descendantsOf(child.pid ?? 0));
			for (const pid of current) {
				tracked.add(pid);
				try {
					process.kill(pid, "SIGSTOP"); // freeze each descendant
				} catch {
					// already gone
				}
			}
			if (current.size === previous.size && [...current].every((pid) => previous.has(pid))) {
				break;
			}
			previous = current;
		}
		// The process group (E group: never kill an undefined/0 pid), which
		// also takes the frozen root down.
		if (child.pid !== undefined && child.pid > 0) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// already gone
				}
			}
		}
		for (const pid of tracked) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// already gone
			}
		}
		const confirm = (): void => {
			void waitAllDead([...tracked]).then((unconfirmed) => resolveKill({ unconfirmed }));
		};
		if (closed.has(child)) {
			confirm();
			return;
		}
		const fallback = setTimeout(confirm, 2000);
		child.once("close", () => {
			clearTimeout(fallback);
			confirm();
		});
	});
}

/**
 * All live pids whose ancestor chain includes `pid`, from the pid table
 * (round 8: `ps -axo pid=,ppid=` — the ONLY way to see a setsid()-escaped
 * process, which is in its own group and invisible to a group kill).
 */
function descendantsOf(pid: number): number[] {
	if (pid <= 0) return [];
	let table: string;
	try {
		table = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", maxBuffer: 1 << 20 });
	} catch {
		return [];
	}
	const children = new Map<number, number[]>();
	for (const line of table.split("\n")) {
		const m = line.trim().match(/^(\d+)\s+(\d+)$/);
		if (m === null) continue;
		const child = Number(m[1]);
		const parent = Number(m[2]);
		if (!children.has(parent)) children.set(parent, []);
		children.get(parent)!.push(child);
	}
	const out: number[] = [];
	const queue = [pid];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const c of children.get(current) ?? []) {
			out.push(c);
			queue.push(c);
		}
	}
	return out;
}

/**
 * Poll the pid table until NONE of the tracked pids is alive (bounded).
 * Returns the pids still alive at the deadline — the caller MUST NOT
 * report "aborted"/"timed out" while any tracked pid survives (round 11).
 */
function waitAllDead(pids: readonly number[]): Promise<number[]> {
	if (pids.length === 0) return Promise.resolve([]);
	return new Promise((resolve) => {
		const deadline = Date.now() + 2000;
		const poll = (): void => {
			const alive: number[] = [];
			for (const pid of pids) {
				try {
					process.kill(pid, 0);
					alive.push(pid);
				} catch (err) {
					if ((err as NodeJS.ErrnoException).code === "EPERM") alive.push(pid);
					// ESRCH — gone
				}
			}
			if (alive.length === 0 || Date.now() > deadline) return resolve(alive);
			setTimeout(poll, 50);
		};
		poll();
	});
}

/**
 * ADR-0058 §6 — a process's identity is its pid AND the time the OS started
 * it: after a runner dies its pid can be handed to an unrelated process, and
 * a live pid alone would then "prove" a task is running. `ps -o lstart=`
 * gives the start time on macOS and Linux alike. "Cannot ask" is `unknown`,
 * never `gone`: a failed query is not evidence of death.
 */
export function processStartTime(pid: number): { kind: "running"; startedAt: string } | { kind: "gone" } | { kind: "unknown" } {
	try {
		const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return startedAt === "" ? { kind: "gone" } : { kind: "running", startedAt };
	} catch (err) {
		const e = err as { status?: number | null; stdout?: string | Buffer };
		// `ps -p` exits 1 with nothing printed when no such process exists;
		// anything else (no `ps`, a signal, other output) could not tell
		if (e.status === 1 && String(e.stdout ?? "").trim() === "") return { kind: "gone" };
		return { kind: "unknown" };
	}
}

/** The output file, rotated at the cap so its tail is always kept. */
export class RotatingOutput {
	readonly #path: string;
	readonly #cap: number;
	#fd: number;
	#size = 0;

	constructor(path: string, cap: number) {
		this.#path = path;
		this.#cap = cap;
		this.#fd = openSync(path, "a");
	}

	write(chunk: Buffer): void {
		if (this.#size > 0 && this.#size + chunk.length > this.#cap) this.#rotate();
		writeSync(this.#fd, chunk);
		this.#size += chunk.length;
	}

	#rotate(): void {
		closeSync(this.#fd);
		renameSync(this.#path, this.#path.replace(/\.log$/, ".1.log"));
		this.#fd = openSync(this.#path, "a");
		const marker = Buffer.from(`[kiso: output rotated after ${this.#size} bytes — the part before is in output.1.log]\n`);
		writeSync(this.#fd, marker);
		this.#size = marker.length;
	}

	close(): void {
		closeSync(this.#fd);
	}
}
