/**
 * W5 — the opening-screen resume list, through the CLI's topmost entry
 * on a REAL PTY. Sessions are pre-written to the REAL store (append-only
 * JSONL, the same files the CLI reads): the banner must surface the
 * relative time + title + the right-aligned "N events · M runs" meta
 * with the meta column aligned (the done-when), the CURRENT session
 * excluded, and the tier gate (BIG only) dropping the list at 13 rows.
 *
 * The final screen is replayed through the scroll-aware VtScreen (the
 * flow-contract model): the run's commit SCROLLS the banner up, so the
 * resume list lands at grid rows 7..9 — the scroll-blind last-write map
 * of the raw bytes would show the banner's pre-scroll positions and lie.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { VtScreen } from "./helpers/vt-screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The ORDERED PTY driver (rows parameterized — the W5 tier gate runs at
 *  a 13-row winch). feeds[i] is written only after feeds[i-1]'s needle
 *  matched, each feed consumed exactly once. The capture is the RAW
 *  bytes as hex — the VtScreen replay needs the true UTF-8 (the "·" in
 *  the meta is 2 bytes; a pre-decoded string would mangle it). */
const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, workdir, timeout, session, rows):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.chdir(workdir)
        os.execvp("node", ["node", cli, "chat", session])
    def winsize(r, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, cols, 0, 0))
    winsize(rows, 80)
    full = b""
    idx = 0
    end = time.time() + timeout
    done = False
    while time.time() < end and not done:
        r, _, _ = select.select([fd], [], [], 0.1)
        if r:
            try:
                data = os.read(fd, 4096)
            except OSError:
                break
            if not data:
                done = True
                break
            full += data
            while idx < len(feeds) and feeds[idx][0].encode() in full:
                os.write(fd, feeds[idx][1].encode())
                idx += 1
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

function ptyRun(
	env: NodeJS.ProcessEnv,
	feeds: [string, string][],
	workdir: string,
	options: { session?: string; rows?: number; timeout?: number } = {},
): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-resume-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${JSON.stringify(workdir)}, ${options.timeout ?? 40}, ${JSON.stringify(options.session ?? "resumeCur")}, ${options.rows ?? 24})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

/** Pre-write two sessions with the REAL append: resumeB is 15 records
 *  (1 user_input + 13 text_delta + a second run) = 15 events · 2 runs,
 *  resumeA is 3 · 1 — the meta texts differ in width, so the alignment
 *  is meaningful. */
async function prewrite(env: NodeJS.ProcessEnv): Promise<void> {
	const store = new SessionStore(join(env.KISO_HOME!, "sessions"));
	await store.append("resumeA", "ra1", { seq: 0, type: "user_input", content: "fix the resize repaint storm" });
	await store.append("resumeA", "ra1", { seq: 1, type: "text_delta", text: "one" });
	await store.append("resumeA", "ra1", { seq: 2, type: "text_delta", text: "two" });
	await store.append("resumeB", "rb1", { seq: 0, type: "user_input", content: "v6 one-compositor gates" });
	for (let i = 1; i < 14; i += 1) {
		await store.append("resumeB", "rb1", { seq: i, type: "text_delta", text: `t${i}` });
	}
	await store.append("resumeB", "rb2", { seq: 14, type: "text_delta", text: "second run" });
	store.closeAll();
}

/** The final screen, replayed through the scroll-aware VtScreen: the
 *  DEC-2026 frames feed ONE emulator (the steady frames are relative
 *  moves — a fresh emulator per frame would misplace them), so the grid
 *  is exactly what a real terminal shows. */
function finalGrid(hex: string, rows: number, cols: number): string[] {
	const s = Buffer.from(hex, "hex").toString("latin1");
	const emu = new VtScreen(rows, cols);
	const first = s.indexOf("\x1b[?2026h");
	emu.write(Buffer.from(s.slice(0, first), "latin1"));
	let at = first;
	while (at >= 0) {
		const end = s.indexOf("\x1b[?2026l", at);
		if (end < 0) break;
		emu.write(Buffer.from(s.slice(at, end + "\x1b[?2026l".length), "latin1"));
		at = s.indexOf("\x1b[?2026h", end);
	}
	return emu.visible();
}

describe("W5 (real PTY) — the opening-screen resume list", () => {
	it("the pre-written sessions surface under the banner: relative now, titles, the meta column aligned at exactly W — the current session excluded", async () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-resume-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		await prewrite(env);
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "text_delta", text: "resume run done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const hex = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				["resume run done", "exit\r"],
			],
			workdir,
			{ session: "resumeCur" },
		);
		const grid = finalGrid(hex, 24, 80);
		// R-G 0.1.47 (ADR-0050): the ~1ms link-lock append merged the
		// opening and the run into ONE sync frame, whose paint sequence
		// never exceeds the 24-row viewport. The W5 unification puts the
		// picker's badge glyph on every data row — both pre-written
		// sessions are mid-run logs, so both wear the interrupted ▌
		// (derived through the SAME projection the picker uses, never a
		// second derivation).
		//
		// R2 supersession: the banner lost its two wordmark rows and its
		// version/tagline row, and gained the keys row, so the list sits
		// one row lower than TT-1B left it. Its POSITION is not the
		// subject — that it appears under the banner, aligned, with the
		// badge on every row, is — so the header is FOUND rather than
		// indexed, and the rows are read relative to it.
		const head = grid.findIndex((r) => r === "  ▞ resume");
		expect(head).toBeGreaterThan(0);
		// resumeB (appended later — updatedAt desc) sorts first: 15 events · 2 runs
		const b = grid[head + 1] ?? "";
		expect(b.startsWith("    ▌ now ")).toBe(true);
		expect(b).toContain("v6 one-compositor gates");
		const a = grid[head + 2] ?? "";
		expect(a.startsWith("    ▌ now ")).toBe(true);
		expect(a).toContain("fix the resize repaint storm");
		// the meta FIELD occupies the same columns on both rows — aligned
		// (the done-when), and the right edge lands at exactly W (80) — the
		// badge column narrows the TITLE field only, never the meta edge
		expect(b.slice(62)).toBe("15 events · 2 runs");
		expect(a.slice(62)).toBe(" 3 events · 1 runs");
		expect(b).toHaveLength(80);
		expect(a).toHaveLength(80);
		// the CURRENT session is excluded: nothing below the list carries
		// the meta — the run's own lines (user line, text, recap) land at
		// the bottom of the content area instead
		expect(grid.slice(head + 3).join("")).not.toContain("events ·");
		expect(grid.join("")).toContain("resume run done");
	});

	it("the tier gate at the winch: 13 rows drops the resume list entirely", async () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-resume-"));
		const workdir = join(dir, "work");
		mkdirSync(workdir, { recursive: true });
		await prewrite(env);
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{ events: [{ type: "text_delta", text: "narrow run done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const hex = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				["narrow run done", "exit\r"],
			],
			workdir,
			{ session: "resumeNarrow", rows: 13 },
		);
		const out = Buffer.from(hex, "hex").toString("utf8");
		// the SAME store carries the same sessions — the tier gate alone drops
		// the list below BIG
		expect(out).not.toContain("▞ resume");
		expect(out).not.toContain("events ·");
	});
});
