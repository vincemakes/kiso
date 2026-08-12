/**
 * R-I-p-3 area — the state-letters parsing gate (the probe's matching).
 *
 * The dogfood mini caught the shipped probe's hole: the exit-path
 * linger's ps output is "?E" — the FIRST character is the
 * no-controlling-terminal marker "?", and the E/Z state letters sit
 * AFTER it. The probe read only state[0] ("?") and judged the dead
 * holder alive — the exact shape Finding R-I-1 documented ("STAT ?E")
 * was not closed by first-character matching. The match must be over
 * the WHOLE state string: the ps state alphabet (macOS + Linux) has no
 * flag letters "E"/"Z" — an occurrence anywhere is the process-state
 * code and the holder is dead.
 *
 * ps is PATH-resolved by the probe, so this gate injects a fake ps (a
 * fixture script printing an env-supplied state string) and pins the
 * four shapes: "?E" and "Z" dead (taken over), "S" alive (refused —
 * the live pin), probe failure alive (refused — the fail-safe pin).
 * The real-ps shapes stay covered by the zombie-holder gate.
 *
 * The red→green spine: the "?E" case fails against the committed
 * probe (state[0] = "?" — LockedError, red) and passes against the
 * whole-string match (green).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LockedError, nativeLockAdapter } from "@vincemakes/kiso-runtime";

const FAKE_PS_DIR = join(fileURLToPath(new URL("../../../tests/fixtures", import.meta.url)), "fake-ps");

/** The lock names the test's OWN pid: kill(pid, 0) must succeed so the
 * probe actually runs — the fake ps then supplies the state shape. */
async function probeState(state: string | null): Promise<LockedError | null> {
	const dir = mkdtempSync(join(tmpdir(), "kiso-probe-lock-"));
	mkdirSync(join(dir, "sessions"), { recursive: true });
	const lockPath = join(dir, "sessions", "probe.lock");
	writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "probe" }), "utf8");
	const savedPath = process.env.PATH;
	const savedState = process.env.FAKE_PS_STATE;
	const savedFail = process.env.FAKE_PS_FAIL;
	process.env.PATH = `${FAKE_PS_DIR}:${savedPath ?? ""}`;
	delete process.env.FAKE_PS_FAIL;
	process.env.FAKE_PS_STATE = state ?? "";
	if (state === null) process.env.FAKE_PS_FAIL = "1";
	try {
		try {
			const handle = await nativeLockAdapter.acquire(lockPath, "probe", () => {});
			expect(handle.pid).toBe(process.pid);
			expect(handle.verify()).toBe(true);
			handle.release();
			expect(existsSync(lockPath)).toBe(true);
			expect(statSync(lockPath).size).toBe(0);
			return null;
		} catch (err) {
			expect(err).toBeInstanceOf(LockedError);
			return err as LockedError;
		}
	} finally {
		if (savedPath === undefined) delete process.env.PATH;
		else process.env.PATH = savedPath;
		if (savedState === undefined) delete process.env.FAKE_PS_STATE;
		else process.env.FAKE_PS_STATE = savedState;
		if (savedFail === undefined) delete process.env.FAKE_PS_FAIL;
		else process.env.FAKE_PS_FAIL = savedFail;
	}
}

describe("R-I-p-3: the state-letters matching (the whole string, not the first char)", () => {
	it('the "?E" exit-path linger (the finding\'s own shape) is DEAD — the takeover proceeds', async () => {
		// Pre-fix (state[0] = "?") this rejects with LockedError — the red.
		expect(await probeState("?E")).toBeNull();
	});

	it("a zombie (STAT Z) is DEAD — the takeover proceeds", async () => {
		expect(await probeState("Z")).toBeNull();
	});

	it("a live process (STAT S) is still ALIVE — refused, the lock untouched (the live pin)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-probe-live-"));
		mkdirSync(join(dir, "sessions"), { recursive: true });
		const lockPath = join(dir, "sessions", "probe.lock");
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live" }), "utf8");
		const savedPath = process.env.PATH;
		const savedState = process.env.FAKE_PS_STATE;
		process.env.PATH = `${FAKE_PS_DIR}:${savedPath ?? ""}`;
		process.env.FAKE_PS_STATE = "S";
		try {
			await expect(nativeLockAdapter.acquire(lockPath, "probe", () => {})).rejects.toThrow(LockedError);
			expect(readFileSync(lockPath, "utf8")).toContain(String(process.pid));
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			if (savedState === undefined) delete process.env.FAKE_PS_STATE;
			else process.env.FAKE_PS_STATE = savedState;
		}
	});

	it("probe failure (unreadable state) stays the fail-safe — refused, the pre-amendment behavior", async () => {
		expect(await probeState(null)).not.toBeNull();
	});
});
