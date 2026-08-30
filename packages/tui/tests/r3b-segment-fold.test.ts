/**
 * R3b/R3d — the TURN fold.
 *
 * DECLARED SUPERSESSION (R3d, owner, 2026-08-28): R3b folded every
 * closed SEGMENT, on a ruling taken before anyone had watched it run.
 * In use it was wrong for a reason the design questions never surfaced:
 * a model narrates between calls, so a real turn is not two or three
 * segments — it is one per tool. Every call became its own
 * `✦ thought 2s · 1 read` row, which is the row count the fold exists
 * to remove, wearing a summary's clothes.
 *
 * The unit is the TURN now: one line for all of a turn's work, placed
 * where its first work landed, with the narration left exactly where it
 * happened (law 1.7 — work folds, words do not). The segment machinery
 * stays: it is what tracks membership, trouble and the expand's runs.
 *
 * design.md §8 named this and forbade it in a visual round: "folding at
 * every text boundary changes what commits and when, which is the
 * machinery every scrollback gate watches". The owner ruled it a round
 * of its own, and ruled the two questions that decide its shape: a
 * segment folds the MOMENT text arrives (not at the turn's end), and
 * each fold reports its OWN segment (not a running total).
 *
 * A segment is a maximal run of thinking/tool cells with no text
 * between them. It CLOSES at a text block or at the turn's end, and on
 * closing it collapses to one line that names its own key.
 *
 * What these gates hold, in order of what would hurt most if it broke:
 *   - the work is never UNREACHABLE — the fold names ctrl+r and ctrl+r
 *     answers with the run's own rows;
 *   - the fold is emitted ONCE per segment, and never for a segment
 *     that already spilled past the hold into the scrollback;
 *   - counts are per-segment, so the second fold does not repeat the
 *     first's work;
 *   - a one-cell segment does not fold, because one row into one row is
 *     pure loss.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";
import { Screen } from "./helpers/screen.js";

function makeBody(opts: { W?: number; H?: number } = {}) {
	let W = opts.W ?? 80;
	let H = opts.H ?? 24;
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => W, editCol: () => 1, write: (s) => writes.push(s) });
	/** R3i: the SCREEN, as the VT emulator sees it — the honest surface
	 *  for a claim about what a human reads, and the only one that stays
	 *  true as commit timing moves under it. */
	const screen = (): string[] => {
		const sc = new Screen(W, H);
		sc.feed(writes.join(""));
		return sc.rows.map((r) => r.join("").replace(/\s+$/, "")).filter((l) => l !== "" && !l.startsWith("─") && !l.includes("/ commands"));
	};
	return { body, writes, screen, tick: () => vi.advanceTimersByTime(16), setSize: (w: number, h: number) => { W = w; H = h; } };
}
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
const call = (body: Body, name: string, id: string, input: Record<string, unknown>, out: string): void => {
	body.toolStart(name, id, input);
	body.toolRunning(id);
	body.toolResult(id, { content: out, isError: false });
};

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: 24, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { rows?: number }).rows;
	delete (process.stdout as { columns?: number }).columns;
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

/** a turn: think, read ×3, speak, edit + shell, speak. Two segments. */
function twoSegments(body: Body): void {
	body.userLine("fix the parser");
	body.thinkingAppend("let me look first");
	body.thinkingEnd();
	for (let i = 0; i < 3; i += 1) call(body, "read_file", `r${i}`, { path: `src/f${i}.ts` }, "a\nb");
	body.textAppend("Found it.\n");
	body.textEnd();
	call(body, "edit_file", "e1", { path: "src/f0.ts", search: "a", replace: "b" }, "+1 -1");
	call(body, "shell", "s1", { command: "npm test" }, "exit 0");
	body.textAppend("Fixed.\n");
	body.textEnd();
	body.endTurn(23);
}

describe("R3b — a segment folds at the text boundary", () => {
	/**
	 * DECLARED SUPERSESSION (R3i phase 3, owner-ruled) — ONE LINE PER
	 * STRETCH, not one per turn.
	 *
	 * R3d collapsed the whole turn to a single line, which put every one
	 * of its counts ABOVE all of its prose. The shape the owner asked
	 * for — and photographed — is one summary per stretch of work,
	 * standing with the prose that stretch led to. R3d's stated reason
	 * for leaving the segment was R3b's disease (a chatty model turning
	 * every call into its own `✦ thought 2s · 1 read` row), and it is
	 * answered by the two rules R3b never had: a fold must absorb at
	 * least two rows, and a stretch of exactly one call names its
	 * TARGET. Both are gated in `r3i-commit-semantics.test.ts` ①.
	 */
	it("EACH STRETCH collapses to one line, and every word between survives", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		expect((frame.match(/✦/g) ?? []).length).toBe(2); // two stretches, two lines
		expect(frame).toContain("Found it.");
		expect(frame).toContain("Fixed.");
	});

	it("the counts are each STRETCH's — its own calls, once", () => {
		const { body, screen, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const folds = screen().filter((l) => l.trimStart().startsWith("✦ "));
		expect(folds[0]).toContain("read 3 files");
		expect(folds[0]).not.toContain("edited");
		expect(folds[1]).toContain("edited 1 file");
		expect(folds[1]).toContain("ran 1 shell command");
		expect(folds[1]).not.toContain("read");
	});

	it("the thinking row folds WITH its segment — it is the segment's first cell", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		expect(plain(writes.join(""))).not.toContain("let me look first");
	});

	it("ZERO terms are dropped (owner ruling) — a term earns its place by having a count", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("no reads");
		expect(frame).not.toContain("no edits");
	});
});

describe("R3b — the work is never unreachable", () => {
	it("the fold NAMES ctrl+r, and ctrl+r answers with the run's own rows", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		expect(plain(writes.join(""))).toContain("· ctrl+r");
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		const lines = plain((r as { lines: string[] }).lines.join("\n"));
		// the NEWEST segment first — the pointer walks back the way every
		// other expand in this product walks
		// R3d: ONE fold for the turn, so the key opens the turn's FIRST
		// segment — the reads — and a second press reaches the rest.
		// R3i: the ring is newest-first, and each key opens ITS OWN
		// stretch — so the first press opens the second stretch (the edit
		// and the shell), not the turn's whole work.
		expect(lines).toContain("expanded ·");
		expect(lines).toContain("edited 1 file");
	});

	it("the expansion carries the run's own projection, not a re-listing", () => {
		const { body, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const lines = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		expect(lines).toContain("edit  src/f0.ts"); // W13's own projection, reused — for THIS stretch (R3i)
	});

	it("the expansion is APPENDED, never a rewrite (ADR-0046)", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const before = writes.join("");
		const r = body.expandNext();
		expect(r.kind).toBe("appended");
		// the committed bytes are untouched — the expansion is new content
		expect(writes.join("")).toBe(before);
	});
});

describe("R3b — the fold's boundaries", () => {
	it("a ONE-CELL segment does not fold — one row into one row is pure loss", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("build");
		call(body, "shell", "s1", { command: "make build" }, "exit 0");
		body.textAppend("Built.\n");
		body.textEnd();
		body.endTurn(3);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toContain("✦ thought");
		expect(frame).toContain("shell make build"); // the row keeps its subject
	});

	it("the fold is emitted ONCE per segment, however many cells it holds", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("many");
		for (let i = 0; i < 9; i += 1) call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x");
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(1);
		tick();
		// R3i: this stretch does no thinking, so its line has no thought
		// term (the zero-drop rule) — the fold's own gutter is what makes
		// "exactly once" checkable.
		expect((plain(writes.join("")).match(/✦/g) ?? []).length).toBe(1);
	});

	it("a QUIET turn still folds exactly as W14 made it — the segment never closes until the settle", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("quiet");
		body.thinkingAppend("thinking");
		vi.advanceTimersByTime(19_000); // R3i: the thinking window is real time
		for (let i = 0; i < 5; i += 1) call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x");
		body.endTurn(19);
		tick();
		const frame = plain(writes.join(""));
		// W14's own number — the CLI's measure, not the segment's clock —
		// and A9's chip, which only a quiet turn carries
		// R3i: the seconds are the segment's OWN thinking clock, so the
		// fixture advances it; and the fold carries WORK only — the chip
		// band already committed the human's words, and A9's repeat of
		// them on the fold printed them twice.
		expect(frame).toContain("read 5 files");
		expect(frame).toContain("quiet"); // the band, once
	});

	it("a turn with text does NOT repeat the user's words on the fold — the chip cell already committed", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const frame = plain(writes.join(""));
		expect((frame.match(/fix the parser/g) ?? []).length).toBe(1);
	});
});

/**
 * RETIRED (R3i phase 3, owner-ruled) — "R3b — trouble never folds", in
 * full, with its reasoning answered rather than discarded.
 *
 * R3b refused to fold any run holding a failure, and R3g extended that
 * to denials and interrupts. The rule was extrapolated from law 1.3 in
 * a code comment — the law itself never says it. Read as written, law
 * 1.3 governs MARKS versus WORDS ("an outcome is stated in words …
 * which is also the only form that survives a pipe"), and law 1.7 says
 * "Work folds, words do not". A failed call's work folds; its outcome
 * WORDS ride the fold line.
 *
 * What the retired cases feared was a fold that HID a refusal —
 * `✦ thought 3s · read 20 files` standing over a denied write. A fold
 * that NAMES it (`… · 1 denied: .env`) is a different object, and the
 * human learns more from it than from twenty routine rows held on
 * screen to point at one.
 *
 * The cost R3b accepted in its own words — "a turn that reads twenty
 * files and hits one denial keeps all twenty rows" — was priced as
 * rare. The 0.16.7 dogfood measured it: 2 failures in 28 calls, and
 * zero fold lines in the whole session.
 *
 * The claims live on, inverted, in `r3i-commit-semantics.test.ts` ②:
 * the failure is named on the line, WHICH call it was, and denials,
 * failures and interrupts are different WORDS rather than one colour.
 */

/**
 * R3d — the LAYOUT IS STABLE while the turn runs.
 *
 * The defect the owner named: each tool call runs on its own row
 * BELOW the last, and when the work is over the whole of it becomes
 * "Thought for 17s, read 4 files, listed 1 directory, ran 4 shell
 * commands" — not a re-fold every time a few of them finish, which is
 * what made the UI strange. The layout has to be its own stable thing.
 *
 * R3b folded at every text boundary, so a turn collapsed several times
 * on its way through — rows appeared, then vanished, then appeared
 * again. The screen jumped. These gates pin the temporal contract that
 * replaces it: rows only ACCUMULATE while the turn runs, and the
 * collapse happens exactly ONCE, at the settle.
 */
describe("R3d — the layout only grows until the settle", () => {
	const run = (body: Body, tick: () => void): string[] => {
		const shots: string[] = [];
		body.userLine("look");
		body.thinkingAppend("thinking"); body.thinkingEnd();
		call(body, "list_dir", "l1", { path: "." }, "x");
		body.textAppend("narrating.\n"); body.textEnd();
		call(body, "read_file", "r1", { path: "a.ts" }, "x");
		tick();
		shots.push("mid1");
		call(body, "read_file", "r2", { path: "b.ts" }, "x");
		call(body, "shell", "s1", { command: "npm test" }, "ok");
		tick();
		shots.push("mid2");
		body.textAppend("done.\n"); body.textEnd();
		body.endTurn(9);
		tick();
		return shots;
	};

	/**
	 * DECLARED SUPERSESSION (R3i phase 2) — MID-TURN THE STRETCH IS ONE
	 * LINE, not one row per call.
	 *
	 * This case used to read "mid-turn every call is its OWN row", which
	 * was true and was the defect: a 28-call turn spent 28 rows of a
	 * 30-row live region, so overflow was the NORM on real turns — and a
	 * turn that overflows may not fold (R3f), which is why the fold
	 * missed exactly the turns it exists for. Measured in the 0.16.7
	 * dogfood: 23 tool rows, 17 thinking rows, zero folds.
	 *
	 * What the case still holds, and what it was always for: nothing has
	 * FOLDED yet. The settled form does not appear before the settle.
	 */
	it("mid-turn the stretch is ONE line — and nothing has folded yet", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("look");
		body.thinkingAppend("thinking"); body.thinkingEnd();
		call(body, "list_dir", "l1", { path: "." }, "x");
		body.textAppend("narrating.\n"); body.textEnd();
		call(body, "read_file", "r1", { path: "a.ts" }, "x");
		call(body, "read_file", "r2", { path: "b.ts" }, "x");
		tick();
		const mid = plain(writes.join(""));
		// the OPEN stretch's work rides its line, in the present tense
		expect(mid).toContain("reading 2 files");
		// ...and the calls' own rows are not on screen holding it open
		expect(mid).not.toContain("read  a.ts");
		expect(mid).not.toContain("read  b.ts");
		// R3i phase 3: the CLOSED stretch has already folded — the text
		// that closed it is what committed it, which is the whole point
		// of a fold standing with the prose it led to. It held thinking
		// and ONE call, so its line names the call's TARGET rather than
		// counting it: `✦ listed . · ctrl+r`, which says everything the
		// two rows it replaced said.
		expect(mid).toContain("listed .");
		// and the OPEN stretch has not folded: its line is present tense,
		// carries no key, and the settled form of its work is nowhere
		expect(mid).not.toContain("read 2 files");
	});

	it("a LATER call never removes an earlier row — the layout only grows", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("look");
		call(body, "read_file", "r1", { path: "a.ts" }, "x");
		body.textAppend("one.\n"); body.textEnd();
		tick();
		// the text boundary R3b folded at: nothing may collapse here
		expect(plain(writes.join(""))).not.toContain("✦ thought");
		call(body, "read_file", "r2", { path: "b.ts" }, "x");
		body.textAppend("two.\n"); body.textEnd();
		tick();
		const after = plain(writes.join(""));
		expect(after).not.toContain("✦ thought"); // still not — two boundaries crossed
		expect(after).toContain("read  a.ts"); // and the first row is still there
	});

	it("the collapse happens exactly ONCE, at the settle", () => {
		const { body, writes, tick } = makeBody();
		body.enter();
		body.userLine("look");
		body.thinkingAppend("thinking"); body.thinkingEnd();
		call(body, "list_dir", "l1", { path: "." }, "x");
		body.textAppend("narrating.\n"); body.textEnd();
		call(body, "read_file", "r1", { path: "a.ts" }, "x");
		call(body, "shell", "s1", { command: "npm test" }, "ok");
		body.textAppend("done.\n"); body.textEnd();
		body.endTurn(9);
		tick();
		const frame = plain(writes.join(""));
		// DECLARED SUPERSESSION (R3i phase 3): the collapse happens once
		// PER STRETCH, at that stretch's own close — the shape the owner
		// asked for, one summary standing with the prose it led to. What
		// "exactly once" still forbids, and is still this case's subject,
		// is a stretch collapsing twice or re-collapsing as the turn goes
		// on: two stretches, two lines, no more.
		expect((frame.match(/✦/g) ?? []).length).toBe(2);
		expect(frame).toContain("read 1 file"); // the first stretch's own work
		expect(frame).toContain("ran 1 shell command"); // the second's
		// and both narrations survive, where they happened (law 1.7)
		expect(frame).toContain("narrating.");
		expect(frame).toContain("done.");
	});
});

/**
 * R3f — the fold's key reaches EVERY call the fold counted.
 *
 * The defect (mine, R3d): the fold moved to the TURN while the
 * expansion kept walking one SEGMENT. A turn that spoke between calls
 * folded to a line claiming `3 reads · 1 edit · 1 shell` whose key
 * opened only the reads — the edit and the shell were on no surface and
 * reachable by no key. That is worse than never folding: the line names
 * work and then withholds it, and it breaks this round's own first
 * gate.
 */
describe("R3f — the fold counts nothing it cannot show", () => {
	/**
	 * RETIRED (R3i phase 3) — superseded, and by the rule it was written
	 * to protect.
	 *
	 * R3f widened the expansion to the whole turn because R3d had made
	 * the fold the TURN's while the expansion still walked one segment:
	 * a line claiming `read 3 files · edited 1 file` opened only the
	 * reads, so work was named and then withheld. R3i returns the fold
	 * to the stretch, which makes the pairing exact again — every
	 * stretch has its own line, its own key, and the key opens what the
	 * line named. `r3i-commit-semantics.test.ts` ③ gates that pairing
	 * directly, in both directions (each block holds its own stretch's
	 * work, and NOT the other's).
	 */

	it("the expansion's header says what the FOLD said — the line you pressed and the block agree", () => {
		const { body, tick } = makeBody();
		body.enter();
		twoSegments(body);
		tick();
		const lines = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		// R3i: the header names THIS stretch, which is what the block
		// holds — a header describing the whole turn over a block holding
		// one stretch was the bug this replaces.
		expect(lines).toContain("expanded · edited 1 file · ran 1 shell command");
	});

	it("a run still BREAKS at a non-explore call — the segment boundary keeps its meaning", () => {
		const { body, tick } = makeBody();
		body.enter();
		body.userLine("mix");
		for (let i = 0; i < 3; i += 1) call(body, "read_file", `a${i}`, { path: `a${i}.ts` }, "x");
		call(body, "write_file", "w1", { path: "out.ts", content: "x" }, "wrote");
		for (let i = 0; i < 3; i += 1) call(body, "read_file", `b${i}`, { path: `b${i}.ts` }, "x");
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(5);
		tick();
		const lines = plain((body.expandNext() as { lines: string[] }).lines.join("\n"));
		// two runs, the write between them — the grouping rule survives the
		// expansion covering the whole turn
		expect((lines.match(/read 3 files/g) ?? []).length).toBe(2);
		expect(lines).toContain("write out.ts");
	});
});

/**
 * R3f — a SPILLED turn does not fold.
 *
 * The rule was written at R3b and never wired: `spilled` had a
 * declaration, an initializer and a read, and nothing ever set it — so
 * the read was vacuously true. A turn too big for the screen
 * force-committed its rows EXPANDED into the immutable scrollback and
 * then printed `✦ thought 103s · 43 reads` underneath them, claiming as
 * folded the work standing visible above it. The owner's own 43-call
 * session — the one that started this round — is that shape.
 */
describe("R3f — the fold never claims work the screen already shows", () => {
	/**
	 * PACED, one frame per call — the shape a real session has and the
	 * only one that can spill. Fed synchronously the whole turn arrives
	 * in ONE frame with `endTurn` already run, so the hold releases and
	 * everything commits as the fold without ever entering the live
	 * region: the cap is never crossed and the spill never happens. That
	 * difference is exactly why this defect survived a green suite.
	 */
	const paced = (body: Body, tick: () => void, n: number): void => {
		body.userLine("big");
		for (let i = 0; i < n; i += 1) {
			call(body, "read_file", `r${i}`, { path: `f${i}.ts` }, "x");
			tick(); // the frame between calls — the live region grows here
		}
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(9);
		tick();
	};

	/**
	 * DECLARED SUPERSESSION (R3i phase 2) — the SCENARIO moved; the rule
	 * did not.
	 *
	 * The rule is R3f's and it stands: a stretch whose rows are already
	 * in the terminal's scrollback may not be replaced by a line
	 * claiming them, because ink cannot be taken back. What changed is
	 * what it takes to spill. Twenty paced calls used to overflow the
	 * live region because each held a row of its own; under the R3i
	 * projection the block's height does not depend on the call count at
	 * all, which is the point — so the spill now needs a block that is
	 * itself taller than the screen's live cap, and this case builds one
	 * (H=8 leaves four content rows; the stretch line plus a running
	 * call's window is more than that).
	 */
	it("a stretch that overflows the live region commits expanded and does NOT fold", () => {
		const { body, writes, tick } = makeBody({ H: 8 });
		body.enter();
		body.userLine("big");
		body.thinkingAppend("planning");
		tick();
		body.toolStart("shell", "s", { command: "npm run check" });
		body.toolRunning("s");
		body.toolProgress("s", "vitest run --project unit\n114 passed\n214 passed\n");
		tick();
		body.toolResult("s", { content: "ok", isError: false });
		body.textAppend("done.\n");
		body.textEnd();
		body.endTurn(9);
		tick();
		const frame = plain(writes.join(""));
		expect(frame).not.toMatch(/✦[^\n]*thought \d+s/); // no line claiming a stretch it cannot re-show
		expect(frame).toContain("npm run check"); // and the spilled work still reached the human by name
	});

	it("the SAME paced turn on a screen that fits it DOES fold — the rule is the spill, not the size", () => {
		const { body, writes, tick } = makeBody({ H: 40 });
		body.enter();
		paced(body, tick, 20);
		// The 9 is endTurn's own argument — R3g made both fold branches
		// read the measured thinking seconds instead of re-deriving a
		// wall clock, so this line is falsifiable by that regression too.
		// R3i: the seconds are the SEGMENT's own thinking clock, and this
		// stretch does no thinking — so the zero term is dropped (R3b's
		// rule) and the line is its work alone.
		expect(plain(writes.join(""))).toContain("✦ read 20 files · ctrl+r");
	});
});
