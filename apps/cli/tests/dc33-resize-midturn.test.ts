/**
 * DC-33 — A RESIZE DURING A TURN SCROLLS NOTHING OF OURS.
 *
 * The owner widened the terminal mid-turn and reported two things: the
 * content above did not reflow, and a passage of prose appeared twice.
 * The first is the contract (a committed row is ink — ADR-0046; only
 * the live region is repainted, and `/rewrap` is the sanctioned way to
 * see old prose at a new width). The second was ambiguous from the
 * screen alone, because that session's model was visibly looping.
 *
 * Two gates were near it and neither settled it:
 *   - tui-v4-reflow and tui-v6-resize-idempotence both resize an IDLE
 *     session, AFTER the turn completes;
 *   - tui-v7-flow-contract's W9 resizes for real but counts FRAMES
 *     (repaints exactly once), not content.
 * So a resize that repaints once and duplicates content passed all of
 * them. This is the case that does not.
 *
 * The measurement is the invariant REL-0152-R1 states in the
 * compositor's own words — "a resize scrolls NOTHING of ours" — read
 * off the wire: a line feed is the ONLY way a row of ours enters the
 * terminal's scrollback, so zero LFs after the winch is exactly the
 * claim that nothing was duplicated into history. The turn must
 * already have committed rows when the resize lands, or the case is
 * vacuous — the pre-resize LF count is asserted for that reason.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { Screen } from "../../../packages/tui/tests/helpers/screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const DRIVER = `
import pty, os, time, select, struct, fcntl, termios, signal, sys, json

def run(cli, env, cwd, script, resize_at):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.pop("NO_COLOR", None)
        os.environ.update(env)
        os.environ["KISO_FAUX_SCRIPT"] = script
        os.chdir(cwd)
        os.execvp("node", ["node", cli])
    def win(cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, cols, 0, 0))
    win(60)
    full = b""
    start = time.time()
    sent = False
    off = -1
    while time.time() - start < 20:
        r, _, _ = select.select([fd], [], [], 0.05)
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
        if resize_at > 0 and off < 0 and time.time() - start >= resize_at:
            off = len(full)
            win(100)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    print(json.dumps({"off": off, "bytes": len(full), "sent": sent}))
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

/** A turn that commits a screenful of prose and then holds itself open
 *  on a slow shell — the shape the owner was in when the winch landed. */
/** ONE run per scenario, shared by every case. `execFileSync` blocks the
 *  vitest worker for the whole run, so a spawn per case starved the
 *  reporter's RPC once this file had three of them ("Timeout calling
 *  onTaskUpdate", 60s for the file). The captures are pure data. */
const RUNS = new Map<number, { before: Buffer; after: Buffer }>();
function midTurnResize(resizeAt: number): { before: Buffer; after: Buffer } {
	const hit = RUNS.get(resizeAt);
	if (hit !== undefined) return hit;
	const made = midTurnResizeOnce(resizeAt);
	RUNS.set(resizeAt, made);
	return made;
}

function midTurnResizeOnce(resizeAt: number): { before: Buffer; after: Buffer } {
	const { env } = isolatedEnv();
	// under the repo root: the CLI resolves its workspace packages from
	// the tree it is run in, the same reason the v7 flow puts its fixture
	// here rather than in the system temp dir.
	const dir = mkdtempSync(join(process.cwd(), ".kiso-dc33-"));
	const paras = Array.from({ length: 8 }, (_, i) => ({
		type: "text_delta",
		text: `MARK${String(i + 1).padStart(2, "0")} paragraph ${i + 1} of the answer, long enough to fold at sixty columns and not at one hundred, which is the whole point of the measurement. `,
	}));
	const script = join(dir, "faux.json");
	writeFileSync(
		script,
		JSON.stringify([
			{ events: [{ type: "thinking", text: "Answer at length, then run something slow." }, ...paras, { type: "tool_call_end", callId: "s", name: "shell", input: { command: "sleep 6; echo done" } }, { type: "stop", reason: "tool_use" }] },
			{ events: [{ type: "text_delta", text: "TAILMARK the turn is over." }, { type: "stop", reason: "end_turn" }] },
		]),
		"utf8",
	);
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
run(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_MODE: "bypass" })}, ${JSON.stringify(dir)}, ${JSON.stringify(script)}, ${resizeAt})
`;
	let out: string;
	try {
		out = execFileSync("python3", ["-c", phase], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const nl = out.indexOf("\n");
	const meta = JSON.parse(out.slice(0, nl)) as { off: number; bytes: number; sent: boolean };
	const { off } = meta;
	if (off < 0) console.log("DRIVER:", JSON.stringify(meta), Buffer.from(out.slice(nl + 1).trim(), "hex").toString("utf8").slice(0, 400));
	const full = Buffer.from(out.slice(nl + 1).trim(), "hex");
	expect(off, "the resize never fired").toBeGreaterThan(0);
	return { before: full.subarray(0, off), after: full.subarray(off) };
}

describe("DC-33 — a mid-turn resize", () => {
	// DECLARED SUPERSESSION (DC-34, adjudicated 2026-09-01) — THE LF
	// COUNT WAS A PROXY, AND IT WAS GREEN BECAUSE OF A DEFECT.
	//
	// This case asserted ZERO line feeds across the whole post-winch
	// tail. A line feed is how a row enters the scrollback — but that
	// covers a NEW row exactly as much as a re-emitted one, so the
	// count cannot tell duplication from progress. A mid-turn resize is
	// followed by more streaming, and that prose must commit; asserting
	// zero for the tail forbade the turn from finishing.
	//
	// Worse, HEAD passed it for the wrong reason. The unconditional
	// high-water adopt inflated `#scrolledOff`, `leaving` stayed <= 0,
	// and the post-winch commits were suppressed — LF=0 here AND the
	// prose never reaching history there. The gate and the hole were
	// the same code path.
	//
	// So the claim splits in two: the LITERAL invariant, frame-scoped,
	// which is what REL-0152-R1's sentence actually binds; and the
	// PROTECTION, measured on content, which is what the count was
	// standing in for.
	it("the winch's own repaint frame emits no line feed of ours", () => {
		const { after } = midTurnResize(3.5);
		const text = after.toString("utf8");
		// the frame the resize opens: from its erase to the close of the
		// synchronized-output pair (or the conservative path's cursor-show)
		const erase = /\x1b\[\d+;1H\x1b\[0J/.exec(text);
		expect(erase, "the resize frame emitted no erase — its extent is unreadable").not.toBeNull();
		const from = erase!.index;
		const rel = text.slice(from).search(/\x1b\[\?2026l|\x1b\[\?25h/);
		const frame = text.slice(from, rel < 0 ? undefined : from + rel);
		expect(frame.split("\n").length - 1, "the resize frame scrolled something of ours").toBe(0);
	}, 90_000);

	it("no row committed before the winch is emitted again after it", () => {
		const { before, after } = midTurnResize(3.5);
		// NOT vacuous: rows really had been committed before the winch —
		// a line feed is how one gets there, so a zero here would mean
		// the case never reached the state it is about.
		expect(before.filter((b) => b === 0x0a).length, "nothing had been committed when the resize landed").toBeGreaterThan(4);
		// measured on the SCREEN, not on the wire: a repaint legitimately
		// re-addresses rows the terminal is already showing, so the byte
		// stream carries them twice while the terminal holds them once.
		// What must not happen is a marker standing on two lines of the
		// history — the same discriminator DC-34 uses.
		const screen = new Screen(60, 24);
		screen.feed(before.toString("utf8"));
		screen.resizeTo(100);
		screen.feed(after.toString("utf8"));
		const lines = screen.allLines();
		const twice = ["MARK01", "MARK02", "MARK03", "MARK04", "MARK05", "MARK06", "MARK07", "MARK08"].filter((m) => lines.filter((l) => l.includes(m)).length > 1);
		expect(twice, `the widen put committed prose on two history lines: ${twice.join(" ")}`).toEqual([]);
	}, 90_000);

	it("repaints in place — the prose is re-addressed, never re-fed", () => {
		const { after } = midTurnResize(3.5);
		const text = after.toString("utf8");
		// the repaint DID happen (otherwise the live region would not
		// have taken the new width at all)
		expect(text).toContain("MARK08");
		// and every byte of it was cursor-addressed: a repaint that
		// carried its own newlines is the duplication this gate exists
		// for, and the assertion above already forbids it. Here the
		// positive form: the frame opens with cursor positioning.
		expect(text).toMatch(/\x1b\[\d+;1H/);
	}, 90_000);
});
