/**
 * R-I-p area — the npx-shape dead-holder gate (Finding R-I-1; the kill9
 * gate's blind spot, ADR-0050 Amendment 1).
 *
 * The kill9 gate runs the LOCAL bin as its DIRECT pty child: the python
 * driver's waitpid reaps the killed CLI — no linger, no zombie — the
 * gate could never see the dead-holder refusal. The npx-launched shape
 * is different: the CLI is npx's grandchild; when the group SIGKILL
 * kills npx and the CLI at the same instant, the CLI is orphaned, and
 * an un-reaped dead holder (STAT Z, or the ?E exit-path linger) still
 * reports ALIVE to `kill(pid, 0)`. The adopter's immediate resume is
 * then REFUSED by the ADR-0050 takeover — although the holder is dead
 * and can never execute another session write.
 *
 * This gate reproduces the shape: a WRAPPER (the zombie-holder fixture)
 * produces an un-reaped dead holder that the test can never reap (it is
 * the fixture's child, held unreaped), a session lock names it, and a
 * fresh CLI boot must TAKE OVER at the first session write — the resume
 * succeeds immediately. Red pre-patch (the boot is refused, "locked by
 * another writer"), green post-patch.
 *
 * The trajectory is scripted (the faux provider) — hermetic, no real
 * model; the 0-row pty keeps the dock out (the dock-less fallbacks:
 * "trust this project's .kiso? (y/n)", "approve shell? (y/n)").
 *
 * The boot uses the `chat` subcommand — the first-run shape proven by the
 * 1.0.0 dogfood double (the bare-command default case crashes at the
 * project-trust gate on a fresh home: finding R-I-p-2 in the 1.0.1
 * report, pre-existing, outside this round's stop clause). The gate's
 * subject is the SESSION-WRITE lock takeover — identical under either
 * command shape.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const ZOMBIE_HOLDER = join(fileURLToPath(new URL("../../../tests/fixtures", import.meta.url)), "zombie-holder.mjs");

/** The python PTY driver: boots the CLI on the locked home, answers the
 *  trust gate (if it renders), feeds the task, answers the shell approval
 *  (if the trajectory reaches it), and watches for the pre-patch refusal.
 *  Returns the full capture. */
const DRIVER = `
import pty, os, sys, time, select

def driver(cli, home, script_path, session_id, workdir):
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
        os.execvp("node", ["node", cli, "chat", session_id])
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
                    if not data:
                        return False
                    out += data
                    full += data
                except OSError:
                    return False
        return False
    def send(s):
        try:
            os.write(fd, s)
        except OSError:
            pass   # EIO = the child exited — benign, the capture has it
    try:
        # the project-trust gate (if the env shape fires it) — answer y
        if read_until(b"trust this project's .kiso?", 8):
            send(b"y\\n")
        # the line-mode brick — feed the task (the FIRST session write: the
        # lazy lock acquisition happens here)
        read_until("\\u258c ".encode(), 30)
        send(b"go\\n")
        # the trajectory: answer the shell approval if it renders; watch for
        # the pre-patch refusal (which exits the CLI); the post-run brick
        # signals the run ended (the trajectory's terminal).
        phase = "run"
        deadline = time.time() + 45
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    out += data
                    full += data
                except OSError:
                    break
            if b"locked by another writer" in full:
                phase = "refused"
                break
            if b"approve shell" in out and phase == "run":
                out = b""
                send(b"y\\n")
                phase = "approved"
            if phase == "approved" and "\\u258c ".encode() in out:
                break  # the run ended — the brick is back
        # graceful exit (the EOT on an empty line); a refusal already exited
        if phase != "refused":
            send(b"\\x04")
        time.sleep(0.5)
        # drain the rest until the CLI exits
        end = time.time() + 30
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.2)
            if r:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    out += data
                    full += data
                except OSError:
                    break
    finally:
        sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

const ZOMBIE_TRAJECTORY = [
	{
		events: [
			{ type: "tool_call_end", callId: "s1", name: "shell", input: { command: "echo dead-holder-takeover > taken-over.txt" } },
			{ type: "stop", reason: "tool_use" },
		],
	},
	{ events: [{ type: "stop", reason: "end_turn" }] },
];

describe("R-I-p: the npx-shape dead-holder gate", () => {
	it(
		"a fresh boot on a session locked by an un-reaped dead holder takes over at the first write",
		async () => {
			const env = isolatedEnv();
			const workdir = mkdtempSync(join(tmpdir(), "kiso-zombie-work-"));
			mkdirSync(join(workdir, ".kiso"), { recursive: true });
			writeFileSync(join(workdir, ".kiso", "mcp.json"), '{"mcpServers": {}}\n', "utf8");

			// The wrapper-held dead holder: a guaranteed zombie (STAT Z)
			// that kill(pid,0) reports alive — never reapable by this test.
			const pidFile = join(env.dirs.home, "holder.json");
			const holder = spawn(process.execPath, [ZOMBIE_HOLDER, pidFile], { stdio: "ignore" });
			try {
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

				// The session lock names the dead holder — the shape the
				// npx kill leaves behind.
				mkdirSync(join(env.dirs.home, "sessions"), { recursive: true });
				writeFileSync(
					join(env.dirs.home, "sessions", "zombie-resume.lock"),
					JSON.stringify({ pid: ident!.pid, token: "dead-holder" }),
					"utf8",
				);

				// Boot the CLI on that home. The first session write must
				// TAKE OVER — no refusal, the trajectory runs to its
				// terminal. (Pre-patch: the boot is refused — the red.)
				const scriptPath = join(env.dirs.home, "faux.json");
				writeFileSync(scriptPath, JSON.stringify(ZOMBIE_TRAJECTORY), "utf8");
				writeFileSync(join(env.dirs.home, "driver.py"), DRIVER, "utf8");
				const run = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(env.dirs.home, "driver.py"))}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env.dirs.home)}, ${JSON.stringify(scriptPath)}, "zombie-resume", ${JSON.stringify(workdir)})
`;
				const out = execFileSync("python3", ["-c", run], { encoding: "utf8", timeout: 90_000 });

				// No refusal — the dead holder was judged dead and taken over.
				expect(out).not.toContain("locked by another writer");
				// The trajectory ran: the shell's marker exists and the
				// terminal is durable.
				expect(existsSync(join(workdir, "taken-over.txt"))).toBe(true);
				const records = new SessionStore(join(env.dirs.home, "sessions")).load("zombie-resume");
				expect(records.some((r) => r.event.type === "terminal")).toBe(true);
			} finally {
				holder.kill("SIGKILL");
			}
		},
		120_000,
	);
});
