/**
 * E area — the graceful-exit release gate (R-G 0.1.48, the finding #5
 * companion): the lock's EMPTY released marker is reachable through the
 * CLI's normal exit sequence. The 0.1.47 E-gates killed the process and
 * asserted takeover-ability — the blind spot was the graceful exits: the
 * finally's `agent?.close()` was shadowed dead (finding #5), so NO exit
 * path ever left the marker; every exit left the dead-pid residue.
 *
 * Three exit configurations, each in a REAL PTY, each asserting the lock
 * path's final state = the EMPTY released marker (0 bytes) with NO
 * tombstone left:
 *
 *   ① the interactive exit — Ctrl-D (the EOT) at the empty prompt after
 *     a completed turn (chat.ts:547-553: no run, no panel, empty line);
 *   ② the one-shot `kiso resume <id> <prompt>` — its own exit-0 through
 *     main's finally;
 *   ③ the fd-close — the pty master closed AT the prompt: the slave reads
 *     EOF, the stream 'end' fires the EOT callback (editorInput's wiring),
 *     and the same exit condition decides.
 *
 * Signal deaths are NOT in this gate — the dead-holder takeover is the
 * designed recovery (ADR-0050); the residue after a kill is covered by
 * the kill9 gate. A signal death here is the SIGTERM fallback, which the
 * driver only reaches when the graceful exit itself failed — its residue
 * then fails the assertion, which is exactly the red side.
 *
 * Zero human input: everything is injected over the PTY.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: starts the CLI in a real PTY, drives one of the
 *  three exit configurations, waits for the child to exit on its own, and
 *  only SIGTERMs as the fallback (a fallback leaves the residue — the
 *  marker assertion then fails, which is the gate's red side). */
const PTY_DRIVER = `
import os, sys, time, select, signal

# NOTE the fork style: openpty + plain fork + dup2 — NO setsid. pty.fork
# makes the child the session leader of the pty, and closing the master
# then sends it SIGHUP (kill -HUP), so the EOF would never reach the
# CLI — the fd-close ③ would be a signal death, not a graceful exit.
# The real terminal-close scenario has the CLI inside a shell's session:
# the master close is a plain EOF on stdin, and the 'end' wiring runs the
# exit. Without setsid the child stays in the runner's session, the pty
# is not its controlling terminal, and the master close is exactly that
# plain EOF.
def driver(mode, cli, home, script_path, session_id, workdir):
    master, slave = os.openpty()
    pid = os.fork()
    if pid == 0:
        os.close(master)
        os.dup2(slave, 0)
        os.dup2(slave, 1)
        os.dup2(slave, 2)
        if slave > 2:
            os.close(slave)
        os.environ["KISO_HOME"] = home
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        ext_dir = os.path.join(home, "ext")
        os.makedirs(ext_dir, exist_ok=True)
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = os.path.join(home, "mcp.json")
        os.chdir(workdir)
        if mode == "resume":
            os.execvp("node", ["node", cli, "resume", session_id, "second turn"])
        else:
            os.execvp("node", ["node", cli, session_id])
    os.close(slave)
    fd = master
    out = b""    # working buffer: consumed past every matched needle
    full = b""   # the complete capture, printed at the end
    def read_until(needle, timeout):
        nonlocal out, full
        end = time.time() + timeout
        while time.time() < end:
            idx = out.find(needle)
            if idx >= 0:
                out = out[idx + len(needle):]
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    out += data
                    full += data
                except OSError:
                    return False
        return False
    def jsonl_has(needle, timeout):
        # The durable signal that a turn completed — the stop record ON
        # DISK (kill9's predicate style). The brick re-renders on every
        # repaint (run start, each token frame), so it can NOT tell "the
        # turn finished" apart from "the run began" — the JSONL can.
        end = time.time() + timeout
        while time.time() < end:
            try:
                recs = open(os.path.join(home, "sessions", session_id + ".jsonl")).read()
                if needle in recs:
                    return True
            except FileNotFoundError:
                pass
            time.sleep(0.05)
        return False
    if mode in ("eot", "fdclose"):
        # One text-only turn (the lock is acquired at the first append), then
        # the prompt returns — the exit at the empty prompt.
        read_until("\\u258c ".encode(), 20)   # the boot prompt
        os.write(fd, b"go\\r")
        jsonl_has("end_turn", 30)             # the turn completed ON DISK
        read_until("\\u258c ".encode(), 10)   # the post-turn prompt
        if mode == "eot":
            os.write(fd, b"\\x04")            # the interactive Ctrl-D exit
        else:
            os.close(fd)                      # the fd-close at the prompt
    # Wait for the child's exit; drain output while the fd is still open.
    # After os.close(fd) there is nothing left to read — select on the
    # closed fd would raise EBADF — so that path polls the exit only.
    # 60s for every mode: the full gate runs ~120 files on parallel
    # workers — under that load the child can take longer than 30s to be
    # scheduled back after the EOF; the old 30s deadline SIGTERMed a
    # still-exiting child (the release is fast in isolation: ~400ms) and
    # the fallback's residue failed the marker assertion. The deadline is
    # the gate's, not the product's.
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            wpid, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            wpid = pid                        # already reaped elsewhere
        if wpid == pid:
            break
        if mode == "fdclose":
            time.sleep(0.2)
            continue
        try:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                data = os.read(fd, 4096)
                if data:
                    out += data
                    full += data
        except OSError:
            return
    try:
        os.kill(pid, signal.SIGTERM)        # fallback only — never the green path
    except ProcessLookupError:
        pass
    try:
        _, status = os.waitpid(pid, 0)
    except ChildProcessError:
        status = 0
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

/** Two text-only faux turns — the gate needs NO approval surface. The
 *  resume seed consumes turn 0 (fauxSkip counts its end_turn stop), so
 *  the resume prompt serves turn 1 and the one-shot exits on its own;
 *  the chat modes only ever consume turn 0 before the prompt returns. */
const TEXT_TURN = [
	{ events: [{ type: "stop", reason: "end_turn" }] },
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

/** The resume's seed: a completed text session (one user_input + one
 *  end_turn stop — fauxSkip 1), so the one-shot resume's prompt turn
 *  serves the script's second turn and exits on its own. */
function seedSession(home: string, id: string): void {
	const lines = [
		JSON.stringify({ runId: "r1", ts: 1, event: { seq: 0, type: "user_input", content: "start" } }),
		JSON.stringify({ runId: "r1", ts: 2, event: { seq: 1, type: "stop", reason: "end_turn" } }),
	];
	writeFileSync(join(home, "sessions", `${id}.jsonl`), lines.join("\n") + "\n", "utf8");
}

function lockBytes(home: string, id: string): number {
	try {
		return statSync(join(home, "sessions", `${id}.lock`)).size;
	} catch {
		return -1; // never acquired
	}
}

function tombstones(home: string): string[] {
	return readdirSync(join(home, "sessions")).filter((f) => f.includes(".tomb-"));
}

function runDriver(mode: string, dir: string, home: string, scriptPath: string, sessionId: string): string {
	const workdir = join(dir, "work");
	mkdirSync(workdir, { recursive: true });
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
driver(${JSON.stringify(mode)}, ${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, ${JSON.stringify(sessionId)}, ${JSON.stringify(workdir)})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 150_000 });
}

function freshDir(tag: string): { dir: string; home: string; scriptPath: string } {
	const dir = mkdtempSync(join(tmpdir(), `kiso-ge-${tag}-`));
	const home = join(dir, "home");
	mkdirSync(join(home, "sessions"), { recursive: true });
	const scriptPath = join(dir, "faux.json");
	writeFileSync(scriptPath, JSON.stringify(TEXT_TURN), "utf8");
	writeFileSync(join(dir, "driver.py"), PTY_DRIVER, "utf8");
	return { dir, home, scriptPath };
}

describe("graceful-exit release gate (E area, R-G 0.1.48)", () => {
	it("① the interactive exit — Ctrl-D at the empty prompt — leaves the EMPTY released marker (0 bytes), no tombstone", () => {
		const { dir, home, scriptPath } = freshDir("eot");
		runDriver("eot", dir, home, scriptPath, "ge1");
		expect(lockBytes(home, "ge1")).toBe(0); // the released marker, not the 60-byte identity
		expect(tombstones(home)).toEqual([]);
	}, 180_000);

	it("② the one-shot kiso resume's exit-0 — the lock is released through main's finally", () => {
		const { dir, home, scriptPath } = freshDir("res");
		seedSession(home, "ge2");
		runDriver("resume", dir, home, scriptPath, "ge2");
		expect(lockBytes(home, "ge2")).toBe(0);
		expect(tombstones(home)).toEqual([]);
	}, 180_000);

	/**
	 * darwin-only, and the reason is a real platform difference rather
	 * than a harness quirk (DC-44).
	 *
	 * This case's premise is that closing the pty master reaches the CLI
	 * as a signal-free EOF on stdin. On Linux it does not: closing the
	 * master hangs up the terminal, and the kernel sends SIGHUP to the
	 * session leader. Measured 2026-09-03 in a Linux container — with no
	 * handler installed, node dies of signal 1 before stdin emits
	 * anything at all; install a SIGHUP handler and stdin's 'end' does
	 * arrive.
	 *
	 * PH-F6 settles that SIGTERM and SIGHUP keep their default lethal
	 * disposition, so the release this case is about never runs on
	 * Linux and the lock is left for the next launch to repair — the
	 * kill -9 contract, reached by a gentler-looking door. Whether the
	 * product should install a SIGHUP handler that releases the lock and
	 * re-raises is an owner ruling, recorded as DC-44's open item.
	 */
	it.runIf(process.platform === "darwin")("③ the fd-close at the prompt — the stream EOF fires the EOT callback and the release runs", () => {
		const { dir, home, scriptPath } = freshDir("fd");
		runDriver("fdclose", dir, home, scriptPath, "ge3");
		expect(lockBytes(home, "ge3")).toBe(0);
		expect(tombstones(home)).toEqual([]);
	}, 180_000);
});
