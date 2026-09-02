/**
 * DC-34 — A WIDEN MID-TURN LEAVES A SEAM: the same prose twice, and
 * later a hole in the history.
 *
 * The owner reported prose appearing twice after widening the terminal
 * during a turn — once folded narrow and cut mid-sentence, once folded
 * wide and complete. Two earlier measurements of mine came back clean
 * and both were blind, for a reason worth writing down: they watched
 * the EMISSION channel (a resize emits zero line feeds, which is true
 * and stays true), while the duplication is a CUP repaint over rows
 * 1..k. Nothing is fed twice; the same text is RENDERED in two places
 * that the reader cannot tell apart, because the seam between the
 * terminal's scrollback and its screen is invisible from the outside.
 *
 * The mechanism, from the code:
 *   - every count is physical ROWS at the fold width in force when it
 *     was computed (`#committedLines`, `#lineCache`, `skip`, `floor`,
 *     `#scrolledOff`);
 *   - a resize sets #fullRedraw, which refolds every committed cell and
 *     recomputes `#committedLines` at the new W (compositor.ts:2600) —
 *     on a widen the same text now occupies FEWER rows, so every index
 *     into `all` shifts;
 *   - the resize frame then adopts
 *     `#scrolledOff = max(#scrolledOff, min(skip, all.length))`
 *     (compositor.ts:3711). On a widen `skip` shrank, so the max keeps
 *     the OLD value — a count of narrow rows, used unchanged as an
 *     index into an array of wide rows. Nothing translates it.
 *
 * So the window paints from text EARLIER than the scrollback already
 * holds (the duplicate band), and afterwards `leaving <= 0` suppresses
 * emission until `#committedLines` regrows past the stale count — and
 * the text that marched past in between never enters the scrollback at
 * all (the hole). The two halves are the same off-by-a-refold.
 *
 * THE DISCRIMINATOR, and why the owner's own screenshots could not be
 * one: the script below is the model. Every ~30-character span carries
 * a serial token, each occurring EXACTLY ONCE in the script — asserted
 * here — so "the model repeated itself" is impossible by construction.
 * A token on two lines is duplication; a token on none is the hole.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { Screen } from "../../../packages/tui/tests/helpers/screen.js";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");
const NARROW = 60;
const WIDE = 100;
const ROWS = 24;
const PARAS = 20;
const SEGS = 6; // per paragraph — 6 × ~30 columns ≈ 3 narrow rows each

/** Serial ink: one unique token every ~30 columns, so EVERY physical
 *  row at either width carries at least one, and every token names the
 *  place it came from. */
function paragraphs(): { text: string; tokens: string[] }[] {
	const out: { text: string; tokens: string[] }[] = [];
	for (let p = 1; p <= PARAS; p += 1) {
		const tokens: string[] = [];
		let text = "";
		for (let s = 1; s <= SEGS; s += 1) {
			const tok = `P${String(p).padStart(2, "0")}S${s}`;
			tokens.push(tok);
			text += `${tok} ${"ink".repeat(7)} `; // ~30 columns
		}
		out.push({ text: `${text}\n\n`, tokens });
	}
	return out;
}

const DRIVER = `
import pty, os, time, select, struct, fcntl, termios, signal, sys, json

def run(cli, env, cwd, script, winch_after):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.pop("NO_COLOR", None)
        os.environ.update(env)
        os.environ["KISO_FAUX_SCRIPT"] = script
        os.chdir(cwd)
        os.execvp("node", ["node", cli])
    def win(cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ${ROWS}, cols, 0, 0))
    win(${NARROW})
    full = b""
    start = time.time()
    sent = False
    off = -1
    while time.time() - start < 16:
        r, _, _ = select.select([fd], [], [], 0.02)
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
        # the winch lands once the marker paragraph has streamed
        if winch_after and sent and off < 0 and winch_after.encode() in full:
            off = len(full)
            win(${WIDE})
        # the turn's seal, then let the live band collapse and settle
        if sent and b"\\xe2\\x9c\\xa6 took" in full and time.time() - start > 3:
            break
    deadline = time.time() + 1.5
    while time.time() < deadline:
        r, _, _ = select.select([fd], [], [], 0.2)
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
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    print(json.dumps({"off": off}))
    sys.stdout.write(full.hex())
    sys.exit(0)
`;

type Capture = { screen: Screen; off: number; preLF: number; bytes: Buffer; before: Screen };

/** ONE run per scenario, shared by every case. `execFileSync` blocks the
 *  vitest worker for the whole run, and a spawn per case starved the
 *  reporter's RPC ("Timeout calling onTaskUpdate") once this file had
 *  five of them. The captures are pure data; sharing them changes
 *  nothing a case can observe. */
const CAPTURES = new Map<string, Capture>();
function capture(winchAfter: string | null): Capture {
	const key = winchAfter ?? "";
	const hit = CAPTURES.get(key);
	if (hit !== undefined) return hit;
	const made = captureOnce(winchAfter);
	CAPTURES.set(key, made);
	return made;
}

function captureOnce(winchAfter: string | null): Capture {
	const { env } = isolatedEnv();
	const dir = mkdtempSync(join(process.cwd(), ".kiso-dc34-"));
	try {
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// W18's `delay` pseudo-event — WITHOUT it the whole answer
						// plays in one burst and the winch lands after streaming
						// has stopped, which is a quiet-composer resize, not the
						// mid-answer one this file is named for.
						...paragraphs().flatMap((p) => [{ type: "delay", ms: 120 }, { type: "text_delta", text: p.text }]),
						{ type: "stop", reason: "end_turn" },
					],
				},
			]),
			"utf8",
		);
		const driverPath = join(dir, "driver.py");
		writeFileSync(driverPath, DRIVER, "utf8");
		const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
run(${JSON.stringify(CLI)}, ${JSON.stringify({ ...env, KISO_MODE: "bypass" })}, ${JSON.stringify(dir)}, ${JSON.stringify(script)}, ${JSON.stringify(winchAfter ?? "")})
`;
		const out = execFileSync("python3", ["-c", phase], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
		const nl = out.indexOf("\n");
		const { off } = JSON.parse(out.slice(0, nl)) as { off: number };
		const full = out.slice(nl + 1).trim();
		const bytes = Buffer.from(full, "hex");
		const s = new Screen(NARROW, ROWS);
		if (off < 0) {
			s.feed(bytes.toString("utf8"));
			return { screen: s, off, preLF: 0, bytes, before: s };
		}
		const head = bytes.subarray(0, off);
		s.feed(head.toString("utf8"));
		// the screen as it stood the instant the winch landed
		const before = new Screen(NARROW, ROWS);
		before.feed(head.toString("utf8"));
		s.resizeTo(WIDE);
		s.feed(bytes.subarray(off).toString("utf8"));
		return { screen: s, off, preLF: head.filter((b) => b === 0x0a).length, bytes, before };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Which lines of the whole terminal history each token lands on. */
function placement(s: Screen): Map<string, number[]> {
	const lines = s.allLines();
	const at = new Map<string, number[]>();
	for (const { tokens } of paragraphs()) for (const t of tokens) at.set(t, []);
	lines.forEach((line, i) => {
		for (const t of at.keys()) if (line.includes(t)) at.get(t)!.push(i);
	});
	return at;
}

describe("DC-34 — a widen during a turn", () => {
	it("the script is the model: every token is written exactly once", () => {
		// the discriminator's own precondition. Without this the case
		// cannot tell a renderer's second copy from a model's.
		const all = paragraphs().map((p) => p.text).join("");
		for (const { tokens } of paragraphs()) {
			for (const t of tokens) expect(all.split(t).length - 1, `${t} is not unique in the script`).toBe(1);
		}
	});

	it("CONTROL — with no winch, every token lands on exactly one line", () => {
		const { screen } = capture(null);
		const at = placement(screen);
		const missing = [...at].filter(([, ls]) => ls.length === 0).map(([t]) => t);
		const doubled = [...at].filter(([, ls]) => ls.length > 1).map(([t]) => t);
		// the harness reached the content at all
		expect(at.size - missing.length, "the control never rendered the prose").toBeGreaterThan(30);
		expect(doubled, `the steady state duplicated: ${doubled.slice(0, 6).join(" ")}`).toEqual([]);
	}, 120_000);

	it("no token is on two lines — the widen must not re-render committed prose", () => {
		const { screen, off, preLF } = capture("P12S1");
		expect(off, "the winch never fired").toBeGreaterThan(0);
		// NOT vacuous: rows really had scrolled off before the winch, so
		// #scrolledOff was non-zero and the seam could exist at all.
		expect(preLF, "nothing had been committed when the winch landed").toBeGreaterThan(4);
		const doubled = [...placement(screen)].filter(([, ls]) => ls.length > 1);
		expect(
			doubled.map(([t, ls]) => `${t}@${ls.join(",")}`),
			`the widen rendered committed prose a second time (${doubled.length} tokens)`,
		).toEqual([]);
	}, 120_000);

	it("no token is on ZERO lines — the widen must not drop prose out of the history", () => {
		// the other half of the same off-by-a-refold. The window paints
		// from stale text (the duplicate) and `leaving` stays <= 0 for as
		// long as the stale count exceeds the fresh floor, so the prose
		// that marches past in the meantime never enters the scrollback.
		// It took BOTH rules to close: no refold on a widen, and no
		// high-water mark on the resize frame.
		const { screen } = capture("P12S1");
		const at = placement(screen);
		const missing = [...at].filter(([, ls]) => ls.length === 0).map(([t]) => t);
		expect(missing, `the widen left a hole in the scrollback (${missing.length} tokens)`).toEqual([]);
	}, 120_000);

	// KNOWN RED, and it is MINE, not the ruling's. Option C's operative
	// sentence is "the frame does not repaint the committed rows above
	// the seam"; this case reads that off the wire — the frame must not
	// ADDRESS a row above its own `ESC[N;1H ESC[0J`. With the two rules
	// above the frame no longer paints anything DIFFERENT up there, and
	// the defect the owner reported is gone; what it still does is
	// re-emit identical bytes, because `#write` forgets the whole held
	// screen by design (REL-0152-R1) and the settle's erase goes through
	// it. Making that surgical is a change to a contract older than this
	// round, so the case stays asserted-to-fail rather than softened to
	// something it can pass.
	it.fails("the frame does not paint above the region its own erase claims", () => {
		const { bytes, off } = capture("P12S1");
		expect(off, "the winch never fired").toBeGreaterThan(0);
		const tail = bytes.subarray(off).toString("utf8");
		const erase = /\x1b\[(\d+);1H\x1b\[0J/.exec(tail);
		expect(erase, "the resize frame emitted no erase — the boundary is unreadable").not.toBeNull();
		const owned = Number(erase![1]);
		expect(owned, "the erase claims the whole screen; there is no seam to test").toBeGreaterThan(1);
		const from = erase!.index + erase![0].length;
		const endRel = tail.slice(from).search(/\x1b\[\?2026l|\x1b\[\?25h/);
		const frame = tail.slice(from, endRel < 0 ? undefined : from + endRel);
		const above = [...frame.matchAll(/\x1b\[(\d+);1H/g)].map((m) => Number(m[1])).filter((row) => row < owned);
		expect(above, `the frame addressed ${above.length} row(s) above its own erase`).toEqual([]);
	}, 120_000);
});
