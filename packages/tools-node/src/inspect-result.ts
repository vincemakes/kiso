/**
 * Result Inspect — a bounded query over a child's raw work, by locator.
 *
 * A parent hears of a background task or a subagent through a handoff of a
 * few KiB. When it needs more, it used to go back over the child's area
 * (re-reading what the child read). `inspect_result` reads what the child
 * already left on disk instead, through a ResultRef:
 *
 *   result:task:<taskId>              the task's output (<tasks root>/<id>/output.log)
 *   result:subagent:<childId>         the child's answer (result.md)
 *   result:subagent:<childId>/work    the child's session log, rendered as
 *                                     text lines: one header per tool call,
 *                                     then its result's lines
 *
 * A ref is a LOCATOR, nothing more: no index, no database, no copy. It
 * resolves from ids and the store layout alone, so it survives a restart
 * (a new tool instance resolves the same ref). Its reach is the calling
 * session's own store: a task id is looked up only under the session's
 * task root, and a child id must carry the session's id (children are
 * named `sub-<parent>-<delegation>-<n>-<role>`). A backing file that is gone
 * is a plain "expired" result, never an exception.
 *
 * Every view streams: no file is read whole, so a 100 MB output costs
 * bounded memory, and every result is cut at INSPECT_CAP_BYTES, saying
 * what was cut.
 */

import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { defineTool, type AbortSignalLike, type Tool, type ToolResult } from "@vincemakes/kiso-core";
import type { ShellTasks } from "./index.js";

/** Every result's hard cap, in UTF-8 bytes. */
export const INSPECT_CAP_BYTES = 12_288;
/** What a line keeps for matching and display; the rest is counted. */
const LINE_KEEP_BYTES = 65_536;
/** A displayed line of a file, and of a rendered transcript (chars). */
const FILE_LINE_CHARS = 2_000;
const WORK_LINE_CHARS = 400;
/** A tool call's arguments in its header line (chars). */
const ARGS_CHARS = 300;
/** A session event larger than this is named, not parsed. */
const EVENT_KEEP_BYTES = 8 * 1024 * 1024;
/** How far back a tail reads at most. */
const TAIL_SCAN_BYTES = 1024 * 1024;
const GREP_DEFAULT = 30;
const GREP_MAX = 100;
const PATTERN_MAX = 200;
const TAIL_DEFAULT = 40;
const TAIL_MAX = 1_000;
const RANGE_MAX = 2_000;

export type ResultRef = { readonly kind: "task"; readonly taskId: string } | { readonly kind: "subagent"; readonly childId: string; readonly work: boolean };

export type InspectView =
	| { readonly kind: "info" }
	| { readonly kind: "range"; readonly startLine: number; readonly limit: number }
	| { readonly kind: "grep"; readonly pattern: string; readonly limit?: number }
	| { readonly kind: "tail"; readonly lines?: number };

const TASK_ID = /^t[1-9][0-9]*$/;
/** A session id's alphabet (the store's ID_PATTERN); never `..`, never a separator. */
const CHILD_ID = /^sub-[A-Za-z0-9._-]+$/;

/** A ref's text, parsed — or why it is not one. */
export function parseResultRef(text: string): ResultRef | { readonly error: string } {
	const bad = { error: `not a result ref: ${JSON.stringify(text.slice(0, 120))} — expected result:task:<id>, result:subagent:<childId> or result:subagent:<childId>/work` };
	if (text.startsWith("result:task:")) {
		const id = text.slice("result:task:".length);
		return TASK_ID.test(id) ? { kind: "task", taskId: id } : bad;
	}
	if (text.startsWith("result:subagent:")) {
		let id = text.slice("result:subagent:".length);
		const work = id.endsWith("/work");
		if (work) id = id.slice(0, -"/work".length);
		return CHILD_ID.test(id) && !id.includes("..") ? { kind: "subagent", childId: id, work } : bad;
	}
	return bad;
}

export function formatResultRef(ref: ResultRef): string {
	return ref.kind === "task" ? `result:task:${ref.taskId}` : `result:subagent:${ref.childId}${ref.work ? "/work" : ""}`;
}

/** What backs a ref: a plain file, or a session log rendered on the fly. */
interface Backing {
	readonly render: "file" | "work";
	readonly path: string;
	readonly what: string;
}

type Resolution = { readonly backing: Backing } | { readonly refused: string } | { readonly expired: string };

/**
 * Resolve a ref within the calling session's store. The store is the
 * directory holding `<session>.tasks` — the task root ShellTasks names;
 * child session logs sit beside it as `<childId>.jsonl`.
 *
 * A child's answer is found where it was written: a child that ran as an
 * agent task (every child, when the session has tasks) wrote result.md
 * into its task's directory, whose journal names the child's session; a
 * child run without tasks wrote it into its artifact directory
 * (`<store>/subagent/<childId>/`, or KISO_SUBAGENT_ARTIFACTS under
 * KISO_HOME — the subagent extension's own rule). Either way the answer is
 * served only beside its committed record (result.json), as the handoff
 * reads it.
 */
export function resolveResultRef(ref: ResultRef, sessionId: string | undefined, tasksRoot: string | undefined): Resolution {
	if (sessionId === undefined || tasksRoot === undefined || basename(tasksRoot) !== `${sessionId}.tasks`) {
		return { refused: "inspect_result: this call has no session store to resolve refs in" };
	}
	if (ref.kind === "task") {
		const path = join(tasksRoot, ref.taskId, "output.log");
		if (!existsSync(path)) return { expired: `${formatResultRef(ref)}: no output for task ${ref.taskId} in this session (it never ran here, or its directory was removed)` };
		return { backing: { render: "file", path, what: `task ${ref.taskId}'s output` } };
	}
	if (!ref.childId.startsWith(`sub-${sessionId}-`)) {
		return { refused: `inspect_result: refused — ${ref.childId} is not a child of this session; a ref reaches only the calling session's own tasks and children` };
	}
	const store = dirname(tasksRoot);
	if (ref.work) {
		const path = join(store, `${ref.childId}.jsonl`);
		if (!existsSync(path)) return { expired: `${formatResultRef(ref)}: the child's session log is gone` };
		return { backing: { render: "work", path, what: "the child's tool calls, rendered from its session log" } };
	}
	const dir = taskDirOfChild(tasksRoot, ref.childId) ?? artifactDirOf(store, ref.childId);
	if (dir === null || !existsSync(dir)) return { expired: `${formatResultRef(ref)}: the child's result directory is gone` };
	if (!committed(join(dir, "result.json"))) {
		return { expired: `${formatResultRef(ref)}: the child has no committed result (still running, or it ended without one) — its tool calls: result:subagent:${ref.childId}/work` };
	}
	const path = join(dir, "result.md");
	if (!existsSync(path)) return { expired: `${formatResultRef(ref)}: the child's answer file is gone` };
	return { backing: { render: "file", path, what: "the child's final answer" } };
}

/** The task directory whose journal's `planned` record names this child. */
function taskDirOfChild(tasksRoot: string, childId: string): string | null {
	let ids: string[];
	try {
		ids = readdirSync(tasksRoot).filter((d) => TASK_ID.test(d));
	} catch {
		return null;
	}
	for (const id of ids) {
		const first = firstLine(join(tasksRoot, id, "journal.jsonl"), 262_144);
		if (first === null) continue;
		try {
			const planned = JSON.parse(first) as { type?: unknown; agent?: { session?: unknown } };
			if (planned.type === "planned" && planned.agent?.session === childId) return join(tasksRoot, id);
		} catch {
			// a torn first line names no child
		}
	}
	return null;
}

/** The subagent extension's artifact directory for a child run without
 *  tasks (its artifactDir rule, mirrored). */
function artifactDirOf(store: string, childId: string): string | null {
	const configured = process.env.KISO_SUBAGENT_ARTIFACTS;
	if (configured === undefined || configured === "") return join(store, "subagent", childId);
	const abs = resolve(configured);
	const home = resolve(process.env.KISO_HOME ?? join(homedir(), ".kiso"));
	return abs === home || abs.startsWith(home + sep) ? join(abs, childId) : null;
}

/** A result record commits the answer: an object with a non-empty outcome. */
function committed(path: string): boolean {
	const raw = firstLine(path, 65_536);
	if (raw === null) return false;
	try {
		const parsed = JSON.parse(raw) as { outcome?: unknown } | null;
		return parsed !== null && typeof parsed === "object" && typeof parsed.outcome === "string" && parsed.outcome !== "";
	} catch {
		return false;
	}
}

/** The first line of a file, read within `max` bytes; null when unreadable. */
function firstLine(path: string, max: number): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const buf = Buffer.alloc(max);
		const n = readSync(fd, buf, 0, max, 0);
		const end = buf.subarray(0, n).indexOf(0x0a);
		return buf.subarray(0, end < 0 ? n : end).toString("utf8");
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

/** One line as streamed: what was kept, and the line's whole size. */
interface Line {
	readonly text: string;
	readonly bytes: number;
}

/** A file's lines, streamed in 64 KiB chunks: each line keeps at most
 *  `keep` bytes (the rest is counted, never held), so a single 100 MB line
 *  costs `keep` bytes of memory. */
async function* linesOf(path: string, keep: number, signal?: AbortSignalLike): AsyncGenerator<Line> {
	const stream = createReadStream(path, { highWaterMark: 65_536 });
	let parts: Buffer[] = [];
	let kept = 0;
	let bytes = 0;
	const flush = (): Line => {
		const buf = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
		let text = buf.toString("utf8");
		if (bytes > kept) text = text.replace(/�+$/, "");
		if (text.endsWith("\r")) text = text.slice(0, -1);
		const line = { text, bytes };
		parts = [];
		kept = 0;
		bytes = 0;
		return line;
	};
	const take = (piece: Buffer): void => {
		bytes += piece.length;
		if (kept >= keep) return;
		const slice = piece.length > keep - kept ? piece.subarray(0, keep - kept) : piece;
		parts.push(Buffer.from(slice));
		kept += slice.length;
	};
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			if (signal?.aborted) return;
			let from = 0;
			for (let nl = chunk.indexOf(0x0a, from); nl >= 0; nl = chunk.indexOf(0x0a, from)) {
				take(chunk.subarray(from, nl));
				yield flush();
				from = nl + 1;
			}
			if (from < chunk.length) take(chunk.subarray(from));
		}
		if (bytes > 0) yield flush();
	} finally {
		stream.destroy();
	}
}

/** A file's line count, by streaming its newlines. */
async function countLines(path: string, signal?: AbortSignalLike): Promise<number> {
	let n = 0;
	let last = 0x0a;
	const stream = createReadStream(path, { highWaterMark: 1_048_576 });
	try {
		for await (const chunk of stream as AsyncIterable<Buffer>) {
			if (signal?.aborted) break;
			for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, i + 1)) n += 1;
			if (chunk.length > 0) last = chunk[chunk.length - 1]!;
		}
	} finally {
		stream.destroy();
	}
	return last === 0x0a ? n : n + 1;
}

/** The text lines a ref shows: a file's lines, or a session log rendered. */
function viewLines(backing: Backing, signal?: AbortSignalLike): AsyncGenerator<string> {
	return backing.render === "work" ? renderWork(backing.path, signal) : fileLines(backing.path, signal);
}

async function* fileLines(path: string, signal?: AbortSignalLike): AsyncGenerator<string> {
	for await (const line of linesOf(path, LINE_KEEP_BYTES, signal)) yield shown(line.text, FILE_LINE_CHARS, line.bytes - Buffer.byteLength(line.text));
}

/** A line cut to `chars`, naming what it dropped. */
function shown(text: string, chars: number, unkept = 0): string {
	if (text.length <= chars && unkept <= 0) return text;
	const cut = text.slice(0, chars);
	const dropped = Buffer.byteLength(text) - Buffer.byteLength(cut) + Math.max(0, unkept);
	return `${cut}… [+${dropped} bytes]`;
}

interface Call {
	readonly n: number;
	readonly name: string;
	readonly input: unknown;
}

/**
 * A child's session log as text: each tool call is a header line
 * `#<n> <tool> <compact args>` followed by its result's lines (indented by
 * two spaces), in the order the results arrived. The person's input is
 * shown `> `-led, the run's end as `[end: <outcome>]`. Deltas, thinking
 * and the duplicate execution records are skipped. Calls are numbered in
 * the order the model made them.
 */
export async function* renderWork(path: string, signal?: AbortSignalLike): AsyncGenerator<string> {
	const calls = new Map<string, Call>();
	let n = 0;
	for await (const line of linesOf(path, EVENT_KEEP_BYTES, signal)) {
		if (line.bytes > EVENT_KEEP_BYTES) {
			yield `[an event of ${line.bytes} bytes, too large to render]`;
			continue;
		}
		let e: { type?: unknown; callId?: unknown; name?: unknown; input?: unknown; content?: unknown; isError?: unknown; outcome?: { kind?: unknown } };
		try {
			e = (JSON.parse(line.text) as { event?: typeof e }).event ?? {};
		} catch {
			continue; // a torn line
		}
		if (e.type === "user_input") {
			for (const l of textOf(e.content).split("\n")) yield shown(`> ${l}`, WORK_LINE_CHARS);
		} else if (e.type === "tool_call_end" && typeof e.callId === "string") {
			n += 1;
			calls.set(e.callId, { n, name: typeof e.name === "string" ? e.name : "?", input: e.input });
		} else if (e.type === "tool_result") {
			const id = typeof e.callId === "string" ? e.callId : "";
			const call = calls.get(id) ?? { n: (n += 1), name: "?", input: undefined };
			calls.delete(id);
			yield header(call);
			if (e.isError === true) yield "  (error)";
			for (const l of textOf(e.content).replace(/\n+$/, "").split("\n")) yield shown(`  ${l}`, WORK_LINE_CHARS);
		} else if (e.type === "terminal") {
			yield `[end: ${typeof e.outcome?.kind === "string" ? e.outcome.kind : "unknown"}]`;
		}
	}
	for (const call of calls.values()) {
		yield header(call);
		yield "  (no result)";
	}
}

function header(call: Call): string {
	let args = "";
	try {
		args = call.input === undefined ? "" : JSON.stringify(call.input);
	} catch {
		args = "";
	}
	if (args.length > ARGS_CHARS) args = `${args.slice(0, ARGS_CHARS - 1)}…`;
	return `#${call.n} ${call.name}${args !== "" ? ` ${args}` : ""}`;
}

/** A content field as text: a string, or its text blocks. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: { type?: unknown; text?: unknown }) => (b?.type === "text" && typeof b.text === "string" ? b.text : `[${typeof b?.type === "string" ? b.type : "block"}]`)).join("\n");
}

/** A result built under the cap: lines are added while they fit, and
 *  the footer says what did not. */
class Capped {
	readonly #lines: string[] = [];
	#bytes = 0;
	full = false;
	/** room kept for the footer */
	readonly #room = INSPECT_CAP_BYTES - 400;

	add(line: string): boolean {
		if (this.full) return false;
		const b = Buffer.byteLength(line) + 1;
		if (this.#bytes + b > this.#room) {
			this.full = true;
			return false;
		}
		this.#lines.push(line);
		this.#bytes += b;
		return true;
	}

	/** For a tail: keep the LAST lines that fit. */
	static fromEnd(lines: readonly string[]): { readonly kept: readonly string[]; readonly dropped: number } {
		const room = INSPECT_CAP_BYTES - 400;
		let used = 0;
		let i = lines.length;
		while (i > 0) {
			const b = Buffer.byteLength(lines[i - 1]!) + 1;
			if (used + b > room) break;
			used += b;
			i -= 1;
		}
		return { kept: lines.slice(i), dropped: i };
	}

	text(head: string, foot: string[]): string {
		return [head, ...this.#lines, ...foot].join("\n");
	}
}

const CAP_NOTE = `${INSPECT_CAP_BYTES / 1024} KiB`;

/** Run one view over a resolved ref. */
export async function inspect(refText: string, backing: Backing, view: InspectView, signal?: AbortSignalLike): Promise<ToolResult> {
	const head = `${refText} — ${backing.what}`;
	if (view.kind === "info") {
		const st = statSync(backing.path);
		const lines = backing.render === "work" ? await countRendered(backing, signal) : await countLines(backing.path, signal);
		return {
			content: [
				head,
				`kind: ${backing.render === "work" ? "rendered transcript" : "file"}`,
				`backing file: ${backing.path}`,
				`bytes: ${st.size}${backing.render === "work" ? " (the session log)" : ""}`,
				`lines: ${lines}${backing.render === "work" ? " (rendered)" : ""}`,
				`modified: ${st.mtime.toISOString()}`,
			].join("\n"),
			isError: false,
		};
	}
	if (view.kind === "range") {
		const out = new Capped();
		let n = 0;
		const last = view.startLine + view.limit - 1;
		let next = -1;
		let shownLines = 0;
		for await (const line of viewLines(backing, signal)) {
			n += 1;
			if (n < view.startLine) continue;
			if (n > last) break;
			if (!out.add(`${n}: ${line}`)) {
				next = n;
				break;
			}
			shownLines += 1;
		}
		const foot: string[] = [];
		if (next > 0) foot.push(`[cut at the ${CAP_NOTE} cap: lines ${next}–${last} of the requested range not shown — continue with startLine ${next}]`);
		else if (shownLines === 0) foot.push(`[no lines: it has ${n} ${n === 1 ? "line" : "lines"}]`);
		else if (n < last) foot.push(`[end: it has ${n} ${n === 1 ? "line" : "lines"}]`);
		return { content: out.text(`${head}, lines ${view.startLine}–${last}`, foot), isError: false };
	}
	if (view.kind === "grep") {
		let re: RegExp;
		try {
			re = new RegExp(view.pattern);
		} catch (err) {
			return { content: `inspect_result: invalid pattern: ${(err as Error).message}`, isError: true, errorKind: "precondition" };
		}
		const limit = view.limit ?? GREP_DEFAULT;
		const out = new Capped();
		let n = 0;
		let found = 0;
		let more = false;
		let capped = false;
		for await (const line of viewLines(backing, signal)) {
			n += 1;
			if (!re.test(line)) continue;
			if (found >= limit || capped) {
				more = true;
				break;
			}
			if (!out.add(`${n}: ${line}`)) {
				capped = true;
				more = true;
				break;
			}
			found += 1;
		}
		const foot: string[] = [];
		if (found === 0) foot.push("(no matches)");
		if (capped) foot.push(`[cut at the ${CAP_NOTE} cap after ${found} matches; the next match is at line ${n} — narrow the pattern or grep a range]`);
		else if (more) foot.push(`[stopped at the limit of ${limit} matches; the next match is at line ${n}]`);
		return { content: out.text(`${head}, lines matching /${view.pattern}/`, foot), isError: false };
	}
	const want = view.lines ?? TAIL_DEFAULT;
	const tail = backing.render === "work" ? await tailRendered(backing, want, signal) : await tailFile(backing.path, want, signal);
	const fit = Capped.fromEnd(tail.lines.map((l, i) => `${tail.first + i}: ${l}`));
	const total = tail.first + tail.lines.length - 1;
	const head2 = `${head}, the last ${tail.lines.length} of ${total} ${total === 1 ? "line" : "lines"}`;
	const cut = fit.dropped > 0 ? [`[cut at the ${CAP_NOTE} cap: lines ${tail.first}–${tail.first + fit.dropped - 1} not shown]`] : [];
	return { content: [head2, ...cut, ...fit.kept].join("\n"), isError: false };
}

async function countRendered(backing: Backing, signal?: AbortSignalLike): Promise<number> {
	let n = 0;
	for await (const _ of viewLines(backing, signal)) n += 1;
	return n;
}

/** The last lines of a rendered transcript: a ring of `want` lines. */
async function tailRendered(backing: Backing, want: number, signal?: AbortSignalLike): Promise<{ readonly first: number; readonly lines: readonly string[] }> {
	const ring: string[] = [];
	let n = 0;
	for await (const line of viewLines(backing, signal)) {
		n += 1;
		ring.push(line);
		if (ring.length > want) ring.shift();
	}
	return { first: n - ring.length + 1, lines: ring };
}

/** The last lines of a file, read backward from its end within
 *  TAIL_SCAN_BYTES; the line numbers come from a streamed count. */
async function tailFile(path: string, want: number, signal?: AbortSignalLike): Promise<{ readonly first: number; readonly lines: readonly string[] }> {
	const total = await countLines(path, signal);
	const fd = openSync(path, "r");
	let buf = Buffer.alloc(0);
	let pos: number;
	try {
		pos = statSync(path).size;
		const newlines = (): number => {
			let c = 0;
			const end = buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.length - 1 : buf.length;
			for (let i = buf.indexOf(0x0a); i >= 0 && i < end; i = buf.indexOf(0x0a, i + 1)) c += 1;
			return c;
		};
		while (pos > 0 && buf.length < TAIL_SCAN_BYTES && newlines() < want) {
			const len = Math.min(65_536, pos, TAIL_SCAN_BYTES - buf.length);
			const chunk = Buffer.alloc(len);
			readSync(fd, chunk, 0, len, pos - len);
			pos -= len;
			buf = Buffer.concat([chunk, buf]);
		}
	} finally {
		closeSync(fd);
	}
	if (total === 0) return { first: 1, lines: [] };
	let text = buf.toString("utf8");
	if (pos > 0) text = text.replace(/^�+/, "");
	const parts = text.replace(/\n$/, "").split("\n");
	// the first part began before the scan window: drop it when there are
	// enough whole lines, else show it marked as cut
	let partial = pos > 0;
	if (partial && parts.length > want) {
		parts.shift();
		partial = false;
	}
	const taken = parts.slice(-want);
	if (taken.length < parts.length) partial = false;
	const lines = taken.map((l, i) => `${i === 0 && partial ? "…" : ""}${shown(l.endsWith("\r") ? l.slice(0, -1) : l, FILE_LINE_CHARS)}`);
	return { first: Math.max(1, total - lines.length + 1), lines };
}

/** The view's numbers, checked; a string is the refusal. */
function checkView(view: unknown): InspectView | string {
	if (view === null || typeof view !== "object") return "view must be an object with a kind";
	const v = view as { kind?: unknown; startLine?: unknown; limit?: unknown; pattern?: unknown; lines?: unknown };
	const int = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x);
	switch (v.kind) {
		case "info":
			return { kind: "info" };
		case "range":
			if (!int(v.startLine) || v.startLine < 1) return "range needs startLine, an integer ≥ 1";
			if (!int(v.limit) || v.limit < 1 || v.limit > RANGE_MAX) return `range needs limit, an integer from 1 to ${RANGE_MAX}`;
			return { kind: "range", startLine: v.startLine, limit: v.limit };
		case "grep":
			if (typeof v.pattern !== "string" || v.pattern === "") return "grep needs pattern, a non-empty JavaScript RegExp source";
			if (v.pattern.length > PATTERN_MAX) return `grep pattern is ${v.pattern.length} chars; the limit is ${PATTERN_MAX}`;
			if (v.limit !== undefined && (!int(v.limit) || v.limit < 1 || v.limit > GREP_MAX)) return `grep limit must be an integer from 1 to ${GREP_MAX}`;
			return { kind: "grep", pattern: v.pattern, ...(v.limit !== undefined ? { limit: v.limit as number } : {}) };
		case "tail":
			if (v.lines !== undefined && (!int(v.lines) || v.lines < 1 || v.lines > TAIL_MAX)) return `tail lines must be an integer from 1 to ${TAIL_MAX}`;
			return { kind: "tail", ...(v.lines !== undefined ? { lines: v.lines as number } : {}) };
		default:
			return 'view.kind must be "info", "range", "grep" or "tail"';
	}
}

type InspectInput = { ref: string; view: InspectView };

/** A ref, wherever it appears in model-visible text. */
export const RESULT_REF_PATTERN = /\bresult:(?:task:t[1-9][0-9]*|subagent:sub-[A-Za-z0-9._-]+)/;

/** What the lazy source reads of a session: its id and its log. */
export interface InspectableSession {
	readonly id: string;
	readonly log: { readonly all: readonly { readonly type: string; readonly content?: unknown }[] };
}

/**
 * The owner's rent ruling (option 2, lazy registration): `inspect_result`
 * is NOT in a fresh session's tool table. It joins once the session has
 * produced something inspectable — once its model-visible history (a tool
 * result, or an input: a person's, or a task notice) names a ref: a
 * delegate handoff's "Detailed result:" pointer, a background task's start
 * result or its notice naming result:task:<id>, or, on open/resume, a ref
 * already in the history. It then stays.
 *
 * The host reaches it through a LIVE tool source (an extension's `tools`,
 * which the registry consults at every request snapshot): the check runs
 * as the next request is assembled, after the result or notice has landed
 * in the log, so the very request that can see the pointer carries the
 * tool. The scan is incremental (each event is read once per binding) and
 * the array returned is one stable object, so the table changes exactly
 * once. `bind` names the session the host has open (one at a time); a
 * session's arming is remembered by id across rebinds.
 */
export function lazyInspectResult(opts: Parameters<typeof inspectResultTool>[0]): {
	readonly tools: readonly Tool[];
	bind(session: InspectableSession | undefined): void;
	armed(sessionId: string): boolean;
} {
	const tool = inspectResultTool(opts) as Tool;
	const one: readonly Tool[] = Object.freeze([tool]);
	const none: readonly Tool[] = Object.freeze([]);
	const armed = new Set<string>();
	let bound: InspectableSession | undefined;
	let scanned = 0;
	return {
		get tools(): readonly Tool[] {
			if (bound === undefined) return none;
			if (!armed.has(bound.id)) {
				const all = bound.log.all;
				for (; scanned < all.length; scanned += 1) {
					const e = all[scanned]!;
					if ((e.type === "user_input" || e.type === "tool_result") && RESULT_REF_PATTERN.test(textOf(e.content))) {
						armed.add(bound.id);
						break;
					}
				}
			}
			return armed.has(bound.id) ? one : none;
		},
		bind(session) {
			bound = session;
			scanned = 0;
		},
		armed: (id) => armed.has(id),
	};
}

/** The tool — registered only where a session's tasks are wired. */
export function inspectResultTool(opts: { readonly tasks?: (sessionId: string | undefined) => Pick<ShellTasks, "root"> | undefined }): Tool<InspectInput> {
	return defineTool<InspectInput>({
		name: "inspect_result",
		description:
			"Query a ref from a task notice or subagent handoff (result:task:<id>, result:subagent:<childId>, or …/work for the child's tool calls and results) instead of rereading files. Output capped at 12 KiB.",
		parameters: {
			type: "object",
			properties: {
				ref: { type: "string" },
				view: {
					type: "object",
					description: "range: startLine, limit; grep: pattern (JS RegExp), limit?; tail: lines?",
					properties: {
						kind: { type: "string", enum: ["info", "range", "grep", "tail"] },
						startLine: { type: "number" },
						limit: { type: "number" },
						pattern: { type: "string" },
						lines: { type: "number" },
					},
					required: ["kind"],
					additionalProperties: false,
				},
			},
			required: ["ref", "view"],
			additionalProperties: false,
		},
		// no promptSnippet, on purpose: the tool joins a session's table LAZILY
		// (lazyInspectResult), and the system prompt's tool table is composed
		// per run from the registry — a snippet would change the prompt at the
		// next run and break the prompt cache a second time
		execute: async ({ ref, view }, ctx) => {
			const parsed = parseResultRef(String(ref ?? ""));
			if ("error" in parsed) return { content: `inspect_result: ${parsed.error}`, isError: true, errorKind: "precondition" };
			const checked = checkView(view);
			if (typeof checked === "string") return { content: `inspect_result: ${checked}`, isError: true, errorKind: "precondition" };
			const r = resolveResultRef(parsed, ctx.sessionId, opts.tasks?.(ctx.sessionId)?.root);
			if ("refused" in r) return { content: r.refused, isError: true, errorKind: "precondition" };
			if ("expired" in r) return { content: `expired: ${r.expired}`, isError: false };
			try {
				return await inspect(formatResultRef(parsed), r.backing, checked, ctx.signal);
			} catch (err) {
				// removed between the resolution and the read
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return { content: `expired: ${formatResultRef(parsed)}: its backing file is gone`, isError: false };
				throw err;
			}
		},
	});
}
