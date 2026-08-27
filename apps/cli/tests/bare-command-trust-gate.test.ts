/**
 * R-I-p2 — the bare-command first-run trust gate (Finding R-I-p-2, the
 * 1.0.3 patch round).
 *
 * The BARE-COMMAND boot (`kiso <sessionId>` — the default case) called
 * makeAgent(id) WITHOUT the input source (and without the model flag),
 * while the chat/resume cases pass both. On a TTY, a first-run trust
 * gate (.kiso in the cwd, fresh home) then crashed: the gate's askPanel
 * read through the undefined input — "Cannot read properties of
 * undefined (reading 'question')" on the dock-less fallback, identically
 * on 'panelAsk' with the dock. The 1.0.0 dogfood never hit it (the
 * driver used the `chat` subcommand); the kill9 gates have no .kiso;
 * the zombie-resume gate (R-I-p) also boots via `chat` — the path the
 * crash hides behind. THIS gate goes through the front door: the bare
 * command.
 *
 * The argument-consistency audit (the directive's second deliverable)
 * pinned a SECOND call site with the same defect: `kiso sessions` —
 * the read-only listing. The directive's presumption that the listing
 * "doesn't need input" is disproven by the evidence: the trust gate
 * lives INSIDE makeAgent and asks through the input, so on a TTY with
 * a first-discovery .kiso the listing crashed identically (the
 * dock-less 'question' branch — sessions never enters the dock). The
 * listing itself never writes — the input exists so the gate's ask can
 * be answered. Both cases are pinned here.
 *
 * Red pre-patch: the boot dies at the trust panel — the capture holds
 * the TypeError, no trust question ever presents. Green post-patch:
 * the trust question presents normally, the answer lands, and the
 * session is usable: a real task runs to its durable terminal, the
 * released marker is left, exit 0.
 *
 * The trajectory is scripted (the faux provider) — hermetic, no real
 * model. The pty is REAL-sized (24×100) so the dock renders — the
 * crash's dock branch is the shape under test, not the fallback.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

/** The python PTY driver: boots the CLI with the given argv on a
 *  REAL-sized pty (the dock's panelAsk branch), answers the trust
 *  panel, and then either drives the bare-command session (feeds the
 *  task, answers the shell approval panel, requires the trajectory's
 *  marker — the durable artifact) or, in sessions mode, lets the
 *  listing exit on its own (the listing never writes; only the gate's
 *  ask goes through the input). Prints EXIT=<code> at the end. The
 *  waits search the ACCUMULATED stream (the R-I-p driver lesson:
 *  drain-then-wait starves when the needle lands inside the drain
 *  window).
 *
 * The NEVER-STOP-READING rule (the 1.0.3 finding): the docked exit
 * path calls process.stdin.setRawMode(false) — a tcsetattr whose
 * macOS implementation WAITS for the pty master's unread output to
 * drain. A driver that stops reading once it has what it wants (the
 * old brickback shape — the brick renders during the run too, so the
 * stop fired mid-run) leaves the queue parked and the exit deadlocks
 * in the kernel: the run's durable terminal is written, the lock
 * stays live, EXIT=None. The driver here KEEPS READING from the
 * brick onward until the process itself exits — the reads are the
 * drain that lets the raw-mode restore return. The EOT is sent after
 * the trajectory's marker appears (the durable run-end signal), not
 * on a stream heuristic; the eotSeen deferral covers a late arrival.
 *  */
const DRIVER = `
import fcntl, os, pty, select, struct, sys, termios, time

def driver(cli, home, script_path, workdir, args, sessions_mode):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["KISO_HOME"] = home
        os.environ["KISO_FAUX_SCRIPT"] = script_path
        ext_dir = os.path.join(home, "ext")
        os.makedirs(ext_dir, exist_ok=True)
        os.environ["KISO_EXTENSIONS_DIR"] = ext_dir
        os.environ["KISO_MCP_CONFIG"] = os.path.join(home, "mcp.json")
        os.environ["KISO_SKILLS_DIR"] = os.path.join(home, "skills")
        os.chdir(workdir)
        os.execvp("node", ["node", cli] + args)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    full = b""   # the complete capture, printed at the end
    def read_until(needle, timeout):
        nonlocal full
        end = time.time() + timeout
        while time.time() < end:
            if needle in full:
                return True
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        return False
                    full += data
                except OSError:
                    return False
        return False
    def send(s):
        try:
            os.write(fd, s)
        except OSError:
            pass
    try:
        # the trust panel must present (the crash's own branch) — answer y
        if not read_until(b"trust this project's .kiso?", 8):
            # the pre-patch red: the process died at the panel — the capture
            # holds the TypeError; nothing to answer.
            sys.stdout.write(full.decode(errors="replace"))
            sys.exit(3)
        send(b"y\\r")
        crashed = False
        if sessions_mode:
            # the listing is dock-less and never writes — after the gate's
            # answer it lists and exits on its own. Watch the crash and the
            # exit status.
            deadline = time.time() + 30
            while time.time() < deadline:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        data = os.read(fd, 4096)
                        if not data:
                            break
                        full += data
                    except OSError:
                        break
                if b"Cannot read properties of undefined" in full:
                    crashed = True
                    break
        else:
            # R2: the composer has no prompt glyph, so what says "the panel
            # closed and the dock is back" is the idle status hint.
            if not read_until("/ commands".encode(), 8):
                sys.stdout.write(full.decode(errors="replace"))
                sys.exit(4)
            send(b"go\\r")
            deadline = time.time() + 60
            approved = False
            eot_sent = False
            while time.time() < deadline:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    try:
                        data = os.read(fd, 4096)
                        if not data:
                            break
                        full += data
                    except OSError:
                        break
                if b"Cannot read properties of undefined" in full:
                    crashed = True
                    break
                if not approved and b"needs approval" in full:
                    send(b"1\\r")
                    approved = True
                    continue
                # the trajectory's marker is the durable run-end signal: the
                # tool that wrote it ran, so the run is about to reach its
                # terminal. Let the settle + prompt return, then EOT on the
                # empty line. An early arrival is safe: the eotSeen deferral
                # re-evaluates at the run's end.
                if not eot_sent and os.path.exists(os.path.join(workdir, "trusted.txt")):
                    eot_sent = True
                    time.sleep(1.0)
                    send(b"\\x04")
        # THE EXIT PHASE — reap the exit status: poll waitpid FIRST every
        # iteration, then drain (the reads are the drain that lets the
        # docked exit's setRawMode(false) return — the NEVER-STOP-READING
        # rule). EOF must NEVER break the loop: a healthy exit writes its
        # last bytes, closes the pty, and dies — the read returns EOF a
        # hair before waitpid reports the status, and a break here skipped
        # the reap entirely (the EXIT=None the two cases shared while the
        # process was exiting 0 — probe-verified). The drain keeps the
        # docked exit's raw-mode restore from blocking meanwhile.
        if not crashed:
            end = time.time() + 30
            code = None
            while time.time() < end:
                wpid, status = os.waitpid(pid, os.WNOHANG)
                if wpid == pid:
                    code = os.waitstatus_to_exitcode(status)
                    break
                r, _, _ = select.select([fd], [], [], 0.1)
                if r:
                    try:
                        data = os.read(fd, 4096)
                        if data:
                            full += data
                    except OSError:
                        pass
                time.sleep(0.05)
            sys.stdout.write(full.decode(errors="replace"))
            print(f"EXIT={code}")
        else:
            sys.stdout.write(full.decode(errors="replace"))
            print("EXIT=crash")
    finally:
        sys.exit(0)
`;

const BARE_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "b1", name: "shell", input: { command: "echo bare-command-trust > trusted.txt" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

function runDriver(home: string, workdir: string, args: string[], sessionsMode: boolean): string {
	const scriptPath = join(home, "faux.json");
	writeFileSync(scriptPath, JSON.stringify(BARE_TRAJECTORY), "utf8");
	writeFileSync(join(home, "driver.py"), DRIVER, "utf8");
	const run = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(home, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(home)}, ${JSON.stringify(scriptPath)}, ${JSON.stringify(workdir)}, ${JSON.stringify(args)}, ${sessionsMode ? "True" : "False"})
`;
	return execFileSync("python3", ["-c", run], { encoding: "utf8", timeout: 90_000 });
}

describe("R-I-p2: the first-run trust gate", () => {
	it(
		"the bare command boots on a fresh home with a .kiso artifact: the trust question presents, the answer lands, the session is usable",
		async () => {
			const env = isolatedEnv();
			const workdir = mkdtempSync(join(tmpdir(), "kiso-bare-trust-"));
			mkdirSync(join(workdir, ".kiso"), { recursive: true });
			writeFileSync(join(workdir, ".kiso", "mcp.json"), '{"mcpServers": {}}\n', "utf8");

			const out = runDriver(env.dirs.home, workdir, ["bare-trust-gate"], false);

			// The red marker must be absent — the boot did not crash at the
			// panel (pre-patch: "Cannot read properties of undefined" in the
			// capture, no trust question).
			expect(out).not.toContain("Cannot read properties of undefined");
			expect(out).toContain("trust this project's .kiso?");
			// The session was USABLE: the trajectory's shell ran, the
			// terminal is durable, the lock released, exit 0.
			expect(existsSync(join(workdir, "trusted.txt"))).toBe(true);
			const records = new SessionStore(join(env.dirs.home, "sessions")).load("bare-trust-gate");
			expect(records.some((r) => r.event.type === "terminal")).toBe(true);
			const lockPath = join(env.dirs.home, "sessions", "bare-trust-gate.lock");
			expect(existsSync(lockPath)).toBe(true);
			expect(readFileSync(lockPath, "utf8")).toBe("");
			expect(out).toMatch(/EXIT=0/);
		},
		120_000,
	);

	it(
		"the sessions listing (the audit pin): the trust gate asks through the input on a first-discovery .kiso — the listing itself never writes",
		async () => {
			const env = isolatedEnv();
			const workdir = mkdtempSync(join(tmpdir(), "kiso-sessions-trust-"));
			mkdirSync(join(workdir, ".kiso"), { recursive: true });
			writeFileSync(join(workdir, ".kiso", "mcp.json"), '{"mcpServers": {}}\n', "utf8");

			const out = runDriver(env.dirs.home, workdir, ["sessions"], true);

			// Pre-patch the listing crashed identically to the bare command
			// (the dock-less 'question' branch — sessions never enters the
			// dock): no TypeError, the trust question presented and was
			// answered, the listing exited 0 on its own.
			expect(out).not.toContain("Cannot read properties of undefined");
			expect(out).toContain("trust this project's .kiso?");
			expect(out).toMatch(/EXIT=0/);
		},
		120_000,
	);
});
