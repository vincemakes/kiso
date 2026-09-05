/**
 * DC-54 — `search_text` read every file WHOLE and SYNCHRONOUSLY, with no
 * size cap and no binary check.
 *
 * The owner asked kiso, with the workspace at `~`, to look something up.
 * `list_dir` answered in 4 ms; `search_text` never answered at all. The
 * session log ends mid-call, at `tool_execution_started`, with no result
 * record of any kind — and the log ending IS the evidence: the session
 * writer runs on the same event loop, so a blocked loop cannot append.
 *
 * Under `~` the walk reaches 296,924 files totalling 1,063 GB, and every
 * one of them went through
 *
 *     const text = readFileSync(full, "utf8");
 *
 * Measured on that machine: a 467 MB `.mov` READ SUCCESSFULLY — 3,817 ms
 * of dead loop and 2.06 GB of RSS, split into 1,823,112 "lines"; a
 * 10.7 GB disk image cost 2,489 ms and 4.34 GB of RSS before throwing
 * ERR_STRING_TOO_LONG into a bare `catch {}`; and a 994 GB sparse
 * `Docker.raw` never returned at all.
 *
 * Why R3's gate did not catch it: R3 made the WALK yield, and its
 * comment claimed this stopped "a long read stretch" monopolising the
 * loop. That is false and cannot be true — `breathe()` runs BETWEEN
 * files, and nothing can preempt a single `readFileSync` once entered.
 * R3's fixture is 80 small files, so it never met one. A gate scoped to
 * one cause of a freeze cannot see another.
 *
 * The ruling (2026-09-05): bound the file, bound the call, say what was
 * skipped. A file over 1 MiB is skipped, not prefix-read — a partial
 * match is a result that needs explaining, and a source file over 1 MiB
 * is almost never what the model wanted. A file whose first 8 KiB
 * contains a NUL is skipped. The read is asynchronous. And the CALL has
 * a budget — 20,000 files or 10 seconds — because per-file bounds still
 * leave 296,924 files to traverse: the tool must ALWAYS return.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listDirTool, readFileTool, searchTextTool } from "../src/index.js";
import type { ToolContext } from "@vincemakes/kiso-core";

const CTX: ToolContext = {
	signal: { aborted: false, addEventListener: () => {}, removeEventListener: () => {} },
} as unknown as ToolContext;

const NEEDLE = "xylophonic";
const MIB = 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
/** The needle in `deep.txt` sits on the line after the filler. */
const DEEP_NEEDLE_LINE = Math.ceil((BINARY_SNIFF_BYTES * 2) / 29) + 1;

/**
 * The oversized fixture is 128 MiB of REAL text, and every part of that
 * sentence was paid for in a false start.
 *
 * Draft 1 used 32 MiB and a 120 ms threshold: the loop-liveness case was
 * GREEN against the broken code, because `readFileSync` of 32 MiB is
 * 36 ms here and even 256 MiB is only 163 ms.
 *
 * Draft 2 used a 2 GiB SPARSE file — instant to create, the shape of the
 * `Docker.raw` that actually froze the owner's machine. Also green, for
 * a worse reason: 2 GiB is past V8's maximum string length, so the
 * broken code THREW `ERR_STRING_TOO_LONG` into its bare `catch {}` and
 * the file never appeared in the output. Both the skip case and the
 * liveness case were satisfied by the defect. A fixture the defect
 * survives is not a fixture.
 *
 * What discriminates is a file the broken code READS SUCCESSFULLY and is
 * slow doing it. Measured here, three trials each: 128 MiB stalls the
 * loop 200/328/200 ms and costs 39 ms to write; 192 MiB stalls
 * 300/310/325 ms and costs 137 ms. 128 MiB is the cheaper of the two
 * with a 2x margin over the threshold, so 128 MiB it is.
 *
 * The needle sits on line 1, so an unfixed search REPORTS this file —
 * which is what makes the skip case red rather than accidentally green.
 * The text is pure ASCII: were there a NUL in the first 8 KiB the binary
 * check would skip it and the SIZE check, the property under test, would
 * never run.
 */
const BIG_BYTES = 128 * MIB;
const SMALL_FILES = 2_000;

let ROOT = "";

beforeAll(async () => {
	ROOT = mkdtempSync(join(tmpdir(), "kiso-dc54-"));

	// The control: an ordinary file whose match must SURVIVE the fix.
	writeFileSync(join(ROOT, "normal.txt"), `nothing\n${NEEDLE} lives here\nnothing\n`);

	// Bigger than the 8 KiB sniff window, with the needle PAST it.
	const filler = "filler line, twenty-eight ch\n"; // 29 bytes
	const fillerLines = Math.ceil((BINARY_SNIFF_BYTES * 2) / filler.length);
	await writeFile(join(ROOT, "deep.txt"), `${filler.repeat(fillerLines)}${NEEDLE} is down here\n`);

	// Binary: a NUL inside the first 8 KiB, with the needle in plain
	// ASCII after it — findable by a naive reader, skipped by a correct
	// one.
	await writeFile(
		join(ROOT, "binary.dat"),
		Buffer.concat([Buffer.from("MZ\0\0\0\0\0\0"), Buffer.from(`${NEEDLE}\n`), Buffer.alloc(9000)]),
	);

	// Oversized, in its OWN directory so the liveness case can search it
	// alone: with 2,000 unrelated files in the way, the fixed path's own
	// work would sit inside the threshold and blunt the measurement.
	const over = join(ROOT, "oversize");
	mkdirSync(over);
	const line = "plain ascii, no NUL at all\n";
	await writeFile(join(over, "big.txt"), `${NEEDLE}\n${line.repeat(Math.ceil(BIG_BYTES / line.length))}`);

	// Bulk, for the call budget and for list_dir's cap. Written in
	// chunks: 2,000 concurrent opens is an EMFILE waiting to happen, and
	// 2,000 SYNCHRONOUS writes would block the worker long enough to
	// starve vitest's reporter RPC — this repo has hit that at 193.
	const bulk = join(ROOT, "bulk");
	mkdirSync(bulk);
	for (let i = 0; i < SMALL_FILES; i += 200) {
		await Promise.all(
			Array.from({ length: Math.min(200, SMALL_FILES - i) }, (_, k) =>
				writeFile(join(bulk, `f${i + k}.txt`), "line one\nline two\n"),
			),
		);
	}
});

/**
 * Run `fn` while sampling the event loop every 20 ms, and report the
 * LONGEST gap between samples. This measures what the owner experienced
 * — a screen that stops moving — rather than the shape of the code, so
 * it survives any rewrite that keeps the property.
 */
async function longestLoopStall<T>(fn: () => Promise<T>): Promise<{ result: T; stallMs: number }> {
	let last = Date.now();
	let worst = 0;
	const timer = setInterval(() => {
		const now = Date.now();
		worst = Math.max(worst, now - last);
		last = now;
	}, 20);
	// Let the interval settle before the work starts, so the first tick's
	// scheduling latency is not counted as a stall.
	await new Promise<void>((r) => setTimeout(r, 60));
	try {
		const result = await fn();
		// The final gap must be taken HERE, not left to the interval.
		// Draft 3 of this gate returned `worst` straight from the loop and
		// both liveness cases went green against 300 ms of measured
		// blockage: an awaited chain resolves through MICROtasks, which run
		// before timers, so `fn()` settled and the interval was cleared
		// before it ever fired to record the stall it had just suffered.
		// The instrument was measuring nothing.
		worst = Math.max(worst, Date.now() - last);
		return { result, stallMs: worst };
	} finally {
		clearInterval(timer);
	}
}

/** 100 ms: 2x under the 200 ms floor the broken path stalls on this
 *  fixture, and comfortably over the ~40 ms a loaded machine can cost the
 *  fixed path, which only stats the file. */
const STALL_LIMIT_MS = 100;

describe("DC-54 — search_text is bounded per file and per call", () => {
	it("still finds the needle in an ordinary file (the fix must not cost coverage that matters)", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE, path: "normal.txt" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain("normal.txt:2");
	});

	it("reads a file WHOLE after sniffing its head — line numbers past byte 8192 are true", async () => {
		// The binary sniff reads 8 KiB at an explicit position, which by
		// contract leaves the handle's position at 0 so the whole-file read
		// still starts at the beginning. That is documented behaviour, not
		// observed behaviour, and everything downstream — every match's
		// line number — rides on it. The needle here sits past the sniff
		// window: if the read resumed at 8192 instead, this file's matches
		// would come back shifted and no other case would notice.
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE, path: "deep.txt" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain(`deep.txt:${DEEP_NEEDLE_LINE}`);
	});

	it("SKIPS a file over 1 MiB rather than reading it — the 994 GB case", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		expect(res.content).not.toContain("big.txt");
	});

	it("bounds the SINGLE-FILE path too — naming the file does not buy an unbounded read", async () => {
		// search_text takes a file as well as a directory (DC-23), and that
		// path calls the same scanFile. Pinned deliberately: an explicitly
		// named 994 GB file is exactly as unreadable as one the walk found,
		// and the note is what keeps the refusal from being silent.
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE, path: "oversize/big.txt" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain("(no matches)");
		expect(res.content).toContain("1 file skipped (large or binary)");
	});

	it("SKIPS a file with a NUL in its first 8 KiB — `.mov`, `.img`, `.raw` are not text", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		expect(res.content).not.toContain("binary.dat");
	});

	it("SAYS what it skipped, in one merged sentence", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE }, CTX);
		// two skipped: big.bin (size) and binary.dat (NUL)
		expect(res.content).toContain("2 files skipped (large or binary)");
	});

	it("the note is ABSENT when nothing was skipped — a note that always fires says nothing", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ pattern: NEEDLE, path: "bulk" }, CTX);
		expect(res.content).not.toContain("skipped (large or binary)");
		expect(res.content).not.toContain("stopped after");
	});

	it("keeps the event loop TURNING over a 128 MiB file — the frozen screen", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT });
		const { stallMs } = await longestLoopStall(() => tool.execute({ pattern: NEEDLE, path: "oversize" }, CTX));
		expect(stallMs).toBeLessThan(STALL_LIMIT_MS);
	});

	it("STOPS at the file budget and names the continuation — the tool always returns", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT, limits: { searchMaxFiles: 50 } });
		const res = await tool.execute({ pattern: NEEDLE, path: "bulk" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain("stopped after 50 files");
		expect(res.content).toContain("narrow the path");
	});

	it("STOPS at the wall-clock budget too", async () => {
		const tool = searchTextTool({ workspaceRoot: ROOT, limits: { searchMaxMs: 1 } });
		const res = await tool.execute({ pattern: NEEDLE, path: "bulk" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain("stopped after");
	});

	it("says so even when the clock expires BEFORE the first file", async () => {
		// The sentinel case. With `stoppedAt > 0` standing in for "did we
		// stop", a budget that expires at zero files read as "never
		// stopped" and the walk ended in silence — the one outcome every
		// note in this tool exists to prevent. `searchMaxMs: -1` is
		// already expired when the deadline is computed, so no timing luck
		// can hide it; the first draft of the case above passed only
		// because a few files happened to fit inside the same millisecond.
		const tool = searchTextTool({ workspaceRoot: ROOT, limits: { searchMaxMs: -1 } });
		const res = await tool.execute({ pattern: NEEDLE, path: "bulk" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain("stopped after 0 files");
	});
});

describe("DC-54 — read_file cannot be made to swallow a disk image", () => {
	it("refuses a file over its ceiling with an actionable precondition, not a freeze", async () => {
		const tool = readFileTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ path: "oversize/big.txt" }, CTX);
		expect(res.isError).toBe(true);
		// The refusal must name the size AND a way forward.
		expect(res.content).toContain("too large to read");
		expect(res.content).toMatch(/\d+(\.\d+)? MiB/);
		expect(res.content).toContain("shell");
	});

	it("keeps the event loop turning when handed that file", async () => {
		const tool = readFileTool({ workspaceRoot: ROOT });
		const { stallMs } = await longestLoopStall(() => tool.execute({ path: "oversize/big.txt" }, CTX));
		expect(stallMs).toBeLessThan(STALL_LIMIT_MS);
	});

	it("reads an ordinary file unchanged — the ceiling is not a behaviour change below it", async () => {
		const tool = readFileTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ path: "normal.txt" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain(NEEDLE);
		expect(res.content).toMatch(/\[rev:/);
	});
});

/**
 * list_dir's defect is real but MILD, and this file says so rather than
 * pretending otherwise: `readdirSync` is synchronous and `.map()` runs
 * over every entry before the 200-entry slice, so a directory with
 * 200,000 entries builds 200,000 strings to show 200. At any fixture
 * size this suite can afford it is invisible — 2,000 entries cost 1 ms
 * even unfixed. So there is NO loop-liveness case here: it would be
 * green against the defect, which is worse than no case at all. What is
 * gated is the contract the fix must not break.
 */
describe("DC-54 — list_dir truncates before it builds", () => {
	it("caps at 200 with an exact overflow note over a 2,000-entry directory", async () => {
		const tool = listDirTool({ workspaceRoot: ROOT });
		const res = await tool.execute({ path: "bulk" }, CTX);
		expect(res.isError).toBe(false);
		expect(res.content).toContain(`200 of ${SMALL_FILES} entries shown`);
		expect(res.content.split("\n").filter((l) => l.startsWith("file ")).length).toBe(200);
	});
});
