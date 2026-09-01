/**
 * v2d — the interleaving-impossibility gate through the CLI's topmost
 * entry, on a REAL PTY (24×80): a faux script fires THREE parallel tools
 * (one needs an approval), a long thinking block, and streaming text in
 * the same frame. After the ANSI strip, EVERY line must fully match a
 * known cell format — any concatenated (interleaved) line fails the lint.
 * The single-writer rule makes interleaving impossible by construction
 * (ADR-0040); this test pins it.
 */

/**
 * DECLARED SUPERSESSION (R3g, 2026-08-28) — the fold's terms are
 * VERB + COUNT + NOUN now ("read 5 files"), where they used to be a
 * bare count and a noun borrowed from the rollup table ("5 reads",
 * "1 match"). Two reasons, one of them a truthfulness bug: that table
 * names what a single-tool rollup COUNTS — "14 matches" means fourteen
 * matched lines — while this line counts CALLS, so one search rendered
 * "1 match" whenever the search had matched any other number. The
 * phrasing is the owner's, from the shape they asked for: "thought 17s
 * · read 4 files · listed 1 directory · ran 4 shell commands".
 */
/**
 * DECLARED SUPERSESSION (R3h, 2026-08-29) — `thought 0s` IS DROPPED, so
 * the fold's lead term is OPTIONAL in these patterns. R3b ruled that a
 * zero term is a sentence about something that did not happen; the
 * thought term was exempt by accident (written before the rule). The
 * faux model emits no thinking, so every fold here led with `thought
 * 0s` — which is exactly the sentence the rule forbids.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isolatedEnv, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const CLI = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "index.js");

const PTY_DRIVER = `
import pty, os, sys, time, select, signal, struct, fcntl, termios

def driver(cli, env, feeds, timeout):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ.update(env)
        os.execvp("node", ["node", cli, "chat"])
    def winsize(rows, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    winsize(24, 80)
    full = b""
    fed = set()
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
            for i, (needle, text) in enumerate(feeds):
                if i not in fed and needle.encode() in full:
                    os.write(fd, text.encode())
                    fed.add(i)
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass
    sys.stdout.write(full.decode(errors="replace"))
    sys.exit(0)
`;

function ptyRun(env: NodeJS.ProcessEnv, feeds: [string, string][], timeout = 40): string {
	const dir = mkdtempSync(join(tmpdir(), "kiso-v2d-"));
	const driverPath = join(dir, "driver.py");
	writeFileSync(driverPath, PTY_DRIVER, "utf8");
	const phase = `
import sys
sys.argv = [""]
exec(open(${JSON.stringify(driverPath)}).read())
driver(${JSON.stringify(CLI)}, ${JSON.stringify(env)}, ${JSON.stringify(feeds)}, ${timeout})
`;
	return execFileSync("python3", ["-c", phase], { encoding: "utf8", timeout: 90_000, env: process.env });
}

/** Every line a cell may render — the KNOWN format set. Any line that
 *  does not fully match one of these is an interleaved (concatenated)
 *  line, which the single-writer rule makes impossible. */
const CELL_LINE = [
	/^\[.*extensions?:.*\]$/, // the banner extensions row (v3 info row)
	/^⋯.*$/, // the ThinkingCell fold (W2: the ⋯ gutter — the midline mark is the state, never the text ellipsis)
	// R3i phase 2 — THE STRETCH LINE, the open run's one row. Its gutter
	// is whichever glyph of the twinkle's cycle the frame is on
	// (✧✦✶✸✺ — §5.2's own set, so the mark that runs is the mark that
	// stays), and its body is the present-tense terms. The lint's
	// subject is interleaving — two cells' content welded into one write
	// — and this is a well-formed single row; it just did not exist when
	// the table was written.
	// DECLARED SUPERSESSION (R6/D3): the stretch line wears NO mark, in
	// any phase. Law 1.3 — a symbol earns its cell by carrying a fact the
	// words do not — and when the fold, the live line and the status row
	// all wore one, none of them distinguished anything. The gutter is
	// two spaces now, which the lint trims, so the shape to recognise is
	// the TERMS: a counting verb, its count and noun, ` · ` between.
	// (design.md §4 listed the mark PROPOSED and §8 listed it OPEN — this
	// is that proposal's ruling arriving, as a decline.)
	//
	// R7a AMENDS D3 by ONE case, owner-ruled 2026-08-31: the line takes
	// the breathing `●` while — and only while — a call is in flight.
	// D3 declined a mark on the SETTLED line, where the words carry the
	// outcome; "work is moving right now" is a fact the words do not
	// carry, which is law 1.3's own test. It is also where the mark
	// migrated FROM: it used to ride each call's head row, so a
	// four-file burst drew four marks distinguishing nothing and a read
	// that returns in 200ms showed one for less time than the eye needs.
	// The prefix is OPTIONAL here and the terms after it are unchanged —
	// the lint's subject is interleaving, and widening the terms would
	// give that up.
	/^(● )?(read|reading|edited|editing|wrote|writing|listed|listing|ran|running|explored|thought|thinking)\b.*$/,

	/^● \S+ .*\d+s?$/, // the ToolCell running (W2: the mark IS the gutter). R3 (§5.2): a running command BREATHES — one glyph, seven greys; the rotation is retired (§5.3)
	/^⏸ \S+ .*$/, // the approval badge (W2: the ⏸ is the left gutter)
	// MOVED (EC-1 ②③, the SCHEDULER-TIMING class — DECLARED THIS ROUND):
	// the metadata segment is OPTIONAL now. A call queued behind the FIFO
	// exclusive fence (ADR-0052 invariant 5) has not started and has
	// nothing to report — the bare `◦ name` row is its honest state.
	/^◦ \S+( .*)?$/, // the ToolCell queued (W2: ◦ replaces → — · is the metadata separator)
	// SUPERSESSION (TUI2-R1, the tool-cell suffix class): the settled head
	// row may end with the self-naming expand affordance — ` · N lines ·
	// ctrl+r expands`, its terse ` · N lines · ctrl+r`, or the bare ` ·
	// ctrl+r` (the width tiers). A cell hiding nothing still matches the
	// unsuffixed form, which is why the tail is optional here.
	// MOVED (R1.5 slice 5, the R1 tool-cell suffix class + the
	// approval-attribution class): the parens hold the facts that are NOT
	// the line count (VD-6) — often none at all, leaving just the timing —
	// and a human verdict rather than a policy byline (VD-11).
	// R2: the settled row's gutter is two spaces, and the lint TRIMS its
	// segments — so the shape to recognise is the verb column itself, no
	// longer a mark that is gone.
	/^\S+ +.*\((?:\S.*, )?\d+\.\ds\)( · (\d+ lines? · )?ctrl\+r( expands)?)?$/, // the ToolCell done (A4: the target rides the head row)
	/^\S+ +.*\((?:\S.*, )?\d+\.\ds\)$/, // the ToolCell failed (an error's own cut row is its affordance — never suffixed)
	/^answer truncated at max_tokens.*$/, // D4: the truncation notice row — R2 (law 1.1): a notice is a sentence, it wears no box corner
	/^✦.*$/, // v3: the recap line ends the run
	/^│(?: .*)?$/, // v7 W7/W10: the bounded block's body rows — the settled tail + the W8 window's blank-padded rows (the "  │ " family, W2's gutter)
	// MOVED (R1.5 slice 11, the panel-frame class — DECLARED THIS ROUND):
	// the panel's bottom edge is a real RULE now (└ + a ─ run to the
	// width), not the bare `└ ` stub it used to close with (VD-13).
	// R2: the panel's `└─────` bottom rule is retired — every panel closes
	// with the ONE dashed rule above. Its pattern is removed rather than
	// left in place: an allowed shape that can no longer occur is a hole
	// in the lint, not a harmless leftover.
	/^└(?: .*)?$/, // v7 W7/W8/W10 + W21: the cut/waiting rows (the "  └ " family — "waiting for output", "+N earlier rows · ctrl+r", "capped by …") + the approval panel's bare └ corner
	/^aborted \(.*\)$/, // the aborted terminal label
	/^error: .*$/, // the error terminal label
	/^▸ .* · \/mode to switch.*$/, // v3 idle status line
	/^⏸ run paused.*$/, // W21: the panel's paused status (the lead owns the input row — the affordance rides the status)
	// TUI v5 #16g: the dock's idle hint — the status row at enter (the
	// status is still empty).
	// R8b: the hint is a LADDER now — ctrl+o joined it, and because the
	// hint is dropped whole when it does not fit, the shorter rungs had
	// to stay so no width loses what used to fit. The alternation is the
	// exact set of rungs, not a wildcard: a row that is any OTHER
	// arrangement of these words is still an interleave and still fails.
	/^\/ commands(?: · ↑ history)?(?: · ctrl\+o transcript)?$/,
	/^[✧✦✶✸✺] working \d+s.*$/, // the running status line — R3 (§5.2): the twinkle, not the retired quadrant rotation
	// MOVED (the focus-marker class, TUI2-R2 ⑤): a running tool cell's
	// head row carries `· ctrl+r` when it is the FOCUSED cell — the one
	// the next press will act on. The affordance IS the marker there, so
	// the row it appears on is exactly one per frame; the pattern above
	// already admitted the unfocused form (`▖ name · 1s`) and this admits
	// the focused one.
	/^● .* · \d+s · ctrl\+r$/,
	/^streaming text.*$/, // the TextCell body
	/^session \S+$/, // the session header
	/^\[faux mode.*$/, // the faux banner line
	// R2 supersession: the wordmark, the tagline and the version row are
	// retired. The opening is the name, three labelled facts (whose values
	// hang under their label when they are long), and one keys row.
	/^kiso \d+\.\d+\.\d+.*$/, // the name row
	/^(MODEL|WORKSPACE|EXTENSIONS) {2,}.*$/, // a labelled fact (the lint trims the indent)
	/^esc interrupt · .*$/, // the keys row
	/^\[.*extensions?:.*$/, // an EXTENSIONS value continuing on its own row
	/^▌\s?.*$/, // the editor's SELF-RENDER row — the LINE-MODE brick (W6-kept byte-for-byte): the editor's first paint rides the CLI's pre-dock console.log message on the same row
	// TUI v5 #16f: the user block — the SGR-7 chip alone (the 2026-08-09
	// ruling retired the ▍ rail + the indent). Classified by its RAW byte
	// shape in the lint (the stripped form would be plain text).
	// R2 (law 1.1): ONE dashed rule is every edge on screen — the
	// composer's two rails, and every panel's open and close. The box
	// (`╭─╮` / `╰─╯`) and the panel's own `─` divider are both retired,
	// and the divider became a blank row, which the lint already skips.
	/^\u2500+$/,
	// R2: the input row is the typed text at COLUMN ONE — no wall, no
	// prompt glyph — so it is classified by its CONTENT like any other
	// plain row, and an EMPTY composer is the blank the lint skips.
	//
	// R2, the PANEL's own rows. They used to be classified by the `│`
	// gutter they all carried; a gutter SCOPES a verbatim block and an
	// approval list is not one, so they carry the block's two-space
	// indent now and are classified by SHAPE, one shape per row kind.
	// This is stricter than the gutter was — `│ anything` admitted every
	// panel row at once, where these name four distinct forms.
	/^\S+ needs approval — asked by .*$/, // the rule line (+ its · fix hint)
	/^[1-9] \S.*$/, // an option row — the digit IS the key (the cursor's row rides the reverse bar and is classified by it)
	/^↑↓ move · .*$/, // the panel's affordance row
	// the panel's TITLE is the call's own subject — arbitrary text, like
	// the TextCell bodies below, so it is listed rather than shaped.
	/^sleep 1; echo hi$/,
	/^\/(?:private\/)?(?:var|tmp)\/\S*$/, // the asky extension's path target
	/^.*· faux · \[turn \d+ · faux\]$/, // the live status bar (session-prefixed)
	/^the tour is done$/, /^streaming text$/, // the TextCell bodies
];

/** Lint the RECONSTRUCTED lines — the raw split at every CSI (the v6
 *  steady-state frames carry NO CUP — the old CUP-only split would merge
 *  the whole steady transcript into one segment), then the pure CSI-
 *  parameter fragments (the move/clear sequences) are filtered and the
 *  line texts ANSI-stripped. A genuine interleave (two cells' content
 *  merged in one write) still lands inside one segment and fails the
 *  format set. */
const lint = (raw: string): string[] => {
	const bad: string[] = [];
	// the v6 write pattern: the MOVE/CLEAR sequences (A/B/G/D/K/J) precede
	// each line — the split at them (NOT at every CSI — a line's own SGRs
	// must stay with it) yields the true line segments
	const segments = raw.split(/\x1b\[[0-9;?]*[ABDGKJ]/);
	for (const seg of segments) {
		// a pure CSI-parameter fragment (e.g. "1A", "1G", "0K") — not a line
		if (/^[0-9;?]*[A-Za-z]$/.test(seg)) continue;
		// TUI v5 #16f: the user block's identity is the SGR-7 chip's own
		// bracket (the 2026-08-09 ruling retired the ▍ rail + the indent —
		// the stripped form would be indistinguishable from plain text, so
		// the RAW segment carries the classifier; the split never breaks
		// the chip: its CSIs are m-final, outside the ABDGKJ split class).
		if (/^\x1b\[7m .* \x1b\[27m/.test(seg)) continue;
		// DECLARED SUPERSESSION (R7): THINKING IS A BLOCK OF WORDS, and it
		// is classified on the RAW segment for exactly the reason the chip
		// above is — stripped and trimmed, an italic paragraph is
		// indistinguishable from any other prose, and a pattern that
		// accepted "any prose" would accept the interleaved lines this
		// lint exists to catch. The classifier is the two-space lead plus
		// the dim+italic pair the ThinkingBlock emits.
		if (/^ {2}\x1b\[2m\x1b\[3m/.test(seg)) continue;
		const t = seg
			.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
			.replace(/\[[0-9;]*m/g, "") // any residual SGR fragment (the split can strand a "[2m")
			.replace(/\r/g, "")
			.trim();
		if (t === "") continue;
		// DC-3 supersession: a QUESTION kiso asks the terminal is not a line
		// of the transcript. `ESC ] 11 ; ? BEL` is the background query sent
		// once at startup; it carries no cell and paints no row. Admitting
		// it here keeps the lint's real subject — two cells' content merged
		// into one write — the only thing it can fail on. The strip has
		// strip only touches CSI, so the query arrives here whole.
		if (/^\x1b\]1[01];\?\x07$/.test(t)) continue;
		if (CELL_LINE.some((re) => re.test(t))) continue;
		bad.push(t);
	}
	return bad;
};

describe("TUI v2d (real PTY, 24×80)", () => {
	it("three parallel tools + an approval + long thinking + streaming text in ONE frame — every line matches a known cell format (no interleaving)", () => {
		const { env, dirs } = isolatedEnv();
		writeFileSync(
			join(dirs.extensions, "asky.mjs"),
			`export default {
	name: "asky",
	approvals: [{ decide: () => ({ action: "ask" }) }],
	tools: [{
		name: "asky_read",
		description: "a tool that needs approval",
		parameters: { type: "object", properties: {} },
		// EC-1 ②: a TRUTHFUL certificate, the kill9 slow_touch precedent —
		// every invocation returns a constant and touches nothing shared, so
		// "shared" is honest for this test tool. Deliberately NOT
		// precommitSafe: the call must still be commit-gated and still meet
		// the human, which is what this frame is about.
		effects: { concurrency: "shared" },
		execute: async () => ({ content: "asky ok", isError: false }),
	}],
};
`,
			"utf8",
		);
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2d-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// Long thinking + streaming text + THREE tools in one
						// burst — every cell active in the same frame.
						{ type: "thinking", text: "T".repeat(120) },
						{ type: "text_delta", text: "streaming text" },
						{ type: "tool_call_end", callId: "c1", name: "list_dir", input: {} },
						// the shell runs LONG enough for the spinner row to paint
						// (a 0.0s echo coalesces away before any frame — the
						// running state never renders)
						{ type: "tool_call_end", callId: "c2", name: "shell", input: { command: "sleep 1; echo hi" } },
						{ type: "tool_call_end", callId: "c3", name: "asky_read", input: {} },
						{ type: "stop", reason: "tool_use" },
					],
				},
				{ events: [{ type: "text_delta", text: "the tour is done" }, { type: "stop", reason: "end_turn" }] },
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				// The asky extension asks for every tool — answer the two
				// panels that actually mount. list_dir NEVER panels: the
				// default tier's read-only allow beats the extension's ask
				// (W21's deny > allow > ask — an allow anywhere in the chain
				// outranks every ask), so it auto-approves and the run
				// launches all three calls immediately — the queue state
				// never paints. The needles ride the OPTIONS row's option-2
				// span — " 2 Yes, don't ask again for <tool>" is plain (no
				// SGR at sel 0), contiguous RAW, and unique per panel: the
				// rule line's tool name sits inside its own bold span, and
				// the no-queue run paints no bare-name row to race the
				// feeds. "y" + enter send the verdict.
				// MOVED (R1.5 slice 11, the panel-frame class — DECLARED THIS
				// ROUND): option 2 no longer repeats the tool name (the
				// panel's title says it, one row above), so the old
				// per-panel needles are gone. The replacement is ORDERED
				// rather than named, and is robust to either panel mounting
				// first: the first "needs approval" answers whichever panel
				// is up, and " · approved" appears only once a HUMAN verdict
				// has settled a card (R1.5 5) — "approved," matches both the
				// bare "(approved," and the "· approved," forms — by which time
				// the second
				// panel is mounted.
				["needs approval", "y\r"],
				["{}", "y\r"],
				["the tour is done", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		// The scenario actually ran: the three tools + the approvals + the
		// text. W21: list_dir auto-approves under the default tier (no
		// panel — the ⏸ badge row is gone, the panel superseded it).
		// MOVED (EC-1 ②③, the SCHEDULER-TIMING class): calls no longer all
		// launch immediately — the undeclared shell is exclusive, so the
		// FIFO fence (ADR-0052 invariant 5) queues the calls behind it and
		// the bare ◦ rows DO paint now; the shell and asky_read each mount
		// a panel post-commit — the rule line ("asked by …"), the settled
		// cells carry the "approved" decision tag, and the 1s shell's
		// spinner row paints (the spinner IS the gutter).
		expect(clean).toContain("shell needs approval"); // the shell panel's rule line
		expect(clean).toContain("asky_read needs approval"); // the asky panel's rule line
		// MOVED (R1.5 slice ④, the running-header class — DECLARED THIS
		// ROUND): the running header used to print a 60-char slice of the
		// call's JSON while the done card printed the plain command
		// (VD-4). One formatter now, and the duration is its own trailing
		// segment rather than a bare "Ns" welded to the text.
		expect(clean).toMatch(/● shell sleep 1; echo hi · \d+s/); // the running shell — R3 (§5.2): a running command BREATHES — one glyph, seven greys; the rotation is retired (§5.3)
		// A4: the target rides the settled head row (list_dir's input is {}
		// → the "(root)" fallback); A5: the decider is NAMED on the rows
		// that auto-approve (the extension's ask lost to the tier's allow).
		// MOVED (R1.5 slice 5, the approval-attribution class — DECLARED
		// THIS ROUND): a POLICY verdict is ambient and silent; a HUMAN
		// verdict is what the row records. `approved by mode:*` was the
		// runtime's backfill for "no policy expressed an opinion", read by
		// a human as an attribution (VD-11).
		// MOVED (TUI2-R2pre ④, the display-verb class — DECLARED THIS ROUND):
		// the settled row says "list", padded into the same 5-column verb
		// gutter the read/edit heads already used — which is the point of
		// the ruling: one screen, one vocabulary.
		// R3b (owner ruling): the turn's three settled calls are inside the
		// segment fold, which names them by COUNT. The verb vocabulary this
		// case pins (one screen, one wording — `list`, not `list_dir`) is
		// asserted where it now lives: the fold's terms, and the expansion.
		expect(clean).toMatch(/listed 1 directory · ran 1 shell command · 1 × asky_read/);


		expect(clean).not.toContain("approved by"); // R1.5 5: no policy byline anywhere
		expect(clean).toContain("streaming text");
		expect(clean).toContain("the tour is done");
		// THE GATE: every line fully matches a known cell format. A
		// concatenated line (a tool line bleeding into the text, two tool
		// lines merged) FAILS the lint.
		const bad = lint(out);
		expect(bad).toEqual([]);
	}, 90_000);

	it("D4 — a max_tokens truncation is NAMED in the scrollback (the notice row, never silent)", () => {
		const { env } = isolatedEnv();
		const dir = mkdtempSync(join(tmpdir(), "kiso-v2d-"));
		const script = join(dir, "faux.json");
		writeFileSync(
			script,
			JSON.stringify([
				{
					events: [
						// the partial answer, then the provider's own max_tokens
						// stop — the kernel's terminal is { kind: "max_tokens" }
						// (loop.ts: terminalForStop), the chat's terminal case
						// names the truncation.
						{ type: "text_delta", text: "streaming text" },
						{ type: "stop", reason: "max_tokens" },
					],
				},
			]),
			"utf8",
		);
		const out = ptyRun(
			{ ...env, KISO_FAUX_SCRIPT: script },
			[
				["▌ ", "go\r"],
				// the notice lands at the run's end — exit at idle
				["answer truncated", "exit\r"],
			],
		);
		const clean = stripANSI(out);
		// D4: the honest notice rides after the partial answer — the cut is
		// named in the scrollback, the model's text intact above it.
		expect(clean).toContain("streaming text");
		expect(clean).toContain('answer truncated at max_tokens — say "continue" to finish');
		expect(clean).not.toContain("┌"); // R2: no box corner on a notice
		const bad = lint(out);
		expect(bad).toEqual([]);
	}, 90_000);
});
