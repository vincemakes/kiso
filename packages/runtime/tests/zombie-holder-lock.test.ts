/**
 * R-I-p area — the controlled zombie repro, in-repo (Finding R-I-1, the
 * ADR-0050 liveness patch).
 *
 * A session lock naming a GUARANTEED zombie (STAT Z) is refused by the
 * takeover while `kill(pid, 0)` reports the zombie alive — the isAlive
 * false positive: POSIX reports a zombie as alive (it exists until
 * reaped), so the protocol judges the dead holder "live foreign" and
 * refuses with "locked by another writer". The resume fails even though
 * the holder is dead: a zombie can never execute another session write.
 *
 * The red→green spine: this test fails against the pre-patch isAlive
 * (the acquire rejects with LockedError — red) and passes against the
 * state-aware probe (E/Z states are dead — the takeover proceeds —
 * green). The lock's own invariants are untouched.
 *
 * The zombie is produced by the zombie-holder fixture: a child that exits
 * while the fixture's event loop is blocked can never be reaped by libuv
 * — a genuine, persistent zombie, held by the fixture (never by this
 * test — waitpid only reaps direct children, and the fixture holds it).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LockedError, nativeLockAdapter } from "../src/lock-adapter.js";

const FIXTURE = join(fileURLToPath(new URL("../../../tests/fixtures", import.meta.url)), "zombie-holder.mjs");

describe("R-I-p: the dead-holder takeover (Finding R-I-1)", () => {
	it("a lock naming a guaranteed zombie (STAT Z) is taken over — kill(pid,0) must not report a zombie alive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-zombie-lock-"));
		const pidFile = join(dir, "holder.json");
		const holder = spawn(process.execPath, [FIXTURE, pidFile], { stdio: "ignore" });
		try {
			// Wait for the fixture to write the holder identity.
			const end = Date.now() + 15_000;
			let ident: { pid: number; state: string } | null = null;
			while (Date.now() < end) {
				try {
					ident = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number; state: string };
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 100));
				}
			}
			expect(ident, "the zombie-holder fixture must produce a holder").not.toBeNull();
			expect(ident!.state, "the fixture must hold a genuine zombie (STAT Z)").toContain("Z");
			// The kernel's view — the false positive the finding is about: a
			// zombie still exists, so kill(pid, 0) reports it alive.
			expect(() => process.kill(ident!.pid, 0)).not.toThrow();

			// A session lock naming the zombie.
			mkdirSync(join(dir, "sessions"), { recursive: true });
			const lockPath = join(dir, "sessions", "zombie-holder.lock");
			writeFileSync(lockPath, JSON.stringify({ pid: ident!.pid, token: "dead-holder" }), "utf8");

			// The ADR-0050 takeover must proceed: the zombie is dead, and can
			// never write again. (Pre-patch: LockedError — the red.)
			const handle = await nativeLockAdapter.acquire(lockPath, "zombie-holder", () => {});
			expect(handle.pid).toBe(process.pid);
			expect(handle.verify()).toBe(true);
			// The lock path now names US.
			expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({ pid: process.pid });

			// The release leaves the usual 0-byte released marker.
			handle.release();
			expect(existsSync(lockPath)).toBe(true);
			expect(statSync(lockPath).size).toBe(0);
		} finally {
			holder.kill("SIGKILL");
		}
	});

	it("a live foreign writer is still refused (the PID-reuse rule is unchanged)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-live-lock-"));
		// A genuinely live foreign process — a long-running child.
		const live = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		try {
			mkdirSync(join(dir, "sessions"), { recursive: true });
			const lockPath = join(dir, "sessions", "live.lock");
			writeFileSync(lockPath, JSON.stringify({ pid: live.pid, token: "live-foreign" }), "utf8");
			// A live foreign writer owns the lock — never taken over. (The
			// live-writer semantics must not move with the liveness patch.)
			await expect(nativeLockAdapter.acquire(lockPath, "live", () => {})).rejects.toThrow(LockedError);
			// The live holder's lock is untouched.
			expect(readFileSync(lockPath, "utf8")).toContain(String(live.pid));
		} finally {
			live.kill("SIGKILL");
		}
	});
});
