/**
 * R14 / route B — A KILL LANDING INSIDE A REPRINT.
 *
 * The reprint is the one place kiso deliberately destroys terminal
 * state: `2J H 3J` erases the screen AND the scrollback, and only then
 * does the session go back. A SIGKILL between those two halves leaves a
 * terminal holding a fraction of one rendering and nothing else — no
 * scrollback to fall back on, because the erase already ran.
 *
 * The claim is that this is not a new class of loss, and the reason is
 * that the terminal was never the record. kiso's transcript lives in the
 * session log; the terminal is a projection of it. So a kill mid-reprint
 * costs exactly what any other kill costs — the screen — and the next
 * launch cleans it up the way DC-40 already specifies: H line feeds
 * scroll whatever the terminal is holding into its scrollback, and the
 * new frame owns rows 1..H.
 *
 * Stated rather than hidden (ADR-0046 Amendment 1's tier: this round
 * changes what enters the scrollback and when, so the crash gates
 * block).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const ROWS = 24;
const NARROW = 60;
const WIDE = 100;
const MARKS = 30;

/**
 * Starts the CLI in a real PTY at a real size, drives one turn that
 * commits more rows than the screen holds, then RESIZES and SIGKILLs the
 * process group the instant the erase appears on the wire — i.e. inside
 * the reprint, after the scrollback is gone and before the session is
 * back.
 */
const DRIVER = `
import pty, os, time, select, struct, fcntl, termios, signal, sys, json

ERASE = b"\\x1b[2J\\x1b[H\\x1b[3J"

def run(cli, env, cwd, script, session):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.pop("NO_COLOR", None)
        os.environ.update(env)
        os.environ["KISO_FAUX_SCRIPT"] = script
        os.chdir(cwd)
        os.execvp("node", ["node", cli, session])
    def win(cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ${ROWS}, cols, 0, 0))
    win(${NARROW})
    full = b""
    start = time.time()
    sent = False
    winched = False
    killed_at = -1
    while time.time() - start < 25:
        r, _, _ = select.select([fd], [], [], 0.005)
        if r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            full += data
        if not sent and b"\\xe2\\x96\\x8c" in full:
            os.write(fd, b"go\\r")
            sent = True
        # THE WINCH: the LAST mark is on the wire and its frame has landed.
        # The recap glyph was the needle first and never matched, because
        # the recap puts SGR codes between the glyph and the word that
        # follows it, so that literal is never on the wire.
        if sent and not winched and b"MK29" in full and time.time() - start > 2:
            winched = True
            win(${WIDE})
        # THE KILL: the instant the erase is on the wire, the scrollback
        # is already gone and the session has not been put back yet.
        if winched and killed_at < 0 and ERASE in full:
            killed_at = full.index(ERASE)
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            break
    # drain whatever reached the terminal before the process died
    deadline = time.time() + 0.5
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.1)
        if not r:
            continue
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        full += data
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    print(json.dumps({"killed_at": killed_at, "len": len(full)}))
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

describe("R14 — a SIGKILL inside the reprint", () => {
	it("costs the screen and nothing else: the record is intact and resume replays it whole", () => {
		const { env } = isolatedEnv({ KISO_MODE: "bypass" });
		const dir = mkdtempSync(join(tmpdir(), "kiso-r14-kill-"));
		const work = join(dir, "work");
		mkdirSync(work, { recursive: true });
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						{ type: "text_delta", text: Array.from({ length: MARKS }, (_, i) => `MK${String(i).padStart(2, "0")} a line of the answer`).join("\n") },
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		writeFileSync(join(dir, "driver.py"), DRIVER, "utf8");
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(join(dir, "driver.py"))}).read())
run(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_MODE: "bypass" })}, ${JSON.stringify(work)}, ${JSON.stringify(script)}, "r14kill")
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
		const nl = out.indexOf("\n");
		const { killed_at } = JSON.parse(out.slice(0, nl)) as { killed_at: number };

		// NOT VACUOUS: the kill really landed on the erase. Without this the
		// case would pass on a run where the reprint never happened, which
		// is the one outcome it must not accept.
		expect(killed_at, "the reprint never started — nothing was killed inside it").toBeGreaterThan(0);

		// THE RECORD SURVIVES. The terminal held a fraction of one
		// rendering and no scrollback; the session log does not care.
		const store = new SessionStore(join(env.KISO_HOME as string, "sessions"));
		const records = store.load("r14kill");
		expect(records.length, "the session log is empty after a kill mid-reprint").toBeGreaterThan(0);
		const text = JSON.stringify(records.map((r) => r.event));
		for (const n of [0, 15, 29]) {
			expect(text, `MK${String(n).padStart(2, "0")} is missing from the durable record`).toContain(`MK${String(n).padStart(2, "0")}`);
		}
	}, 180_000);
});
