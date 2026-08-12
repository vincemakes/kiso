/**
 * E1 (1.2.0) — slice 2, the trace writer (proposal §1.2 + §6).
 *
 * The ledger is OUT-side (ADR-0051 §6): a versionable observation
 * artifact, never part of the correctness ABI. The soft-fail law
 * (work-order): trace loss costs ONE stderr line, then the session runs
 * on — the writer degrades to a no-op on its first I/O failure and
 * never throws into the caller.
 *
 * Async discipline (work-order §9): request lines are ENQUEUED (a sync
 * push, sub-microsecond) and flushed on setImmediate — the model hot
 * path never blocks on the ledger. The run_end line is flushed
 * SYNCHRONOUSLY from the run's finally block: clean-settle marking is
 * where the ledger's story (every hole reconciles as a crash, never as
 * a writer bug) needs the write to have happened before the run ends.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRACE_SCHEMA_VERSION, type TraceLine } from "./record.js";

let cachedRuntimeVersion: string | null | undefined;

/** The runtime's own version, read from the package.json next to the
 *  build; null on failure (soft-fail — the header still ships). */
export function runtimeVersion(): string | null {
	if (cachedRuntimeVersion === undefined) {
		cachedRuntimeVersion = ((): string | null => {
			try {
				const pkg = JSON.parse(
					readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"),
				) as { version?: string };
				return pkg.version ?? null;
			} catch {
				return null;
			}
		})();
	}
	return cachedRuntimeVersion;
}

export interface TraceWriterDeps {
	/** The sessions dir (store.root). The ledger lives in <root>/traces/ —
	 *  NOT flat in root: a flat `<sid>.trace.jsonl` would be enumerated as
	 *  a phantom session by SessionStore.list() and corrupt the bench
	 *  sessions glob (proposal §3.2; the R3a gate pins it). */
	root: string;
	sessionId: string;
}

export class TraceWriter {
	readonly #root: string;
	readonly #sessionId: string;
	readonly #path: string;
	#pending: TraceLine[] = [];
	#flushScheduled = false;
	#degraded = false;

	constructor(deps: TraceWriterDeps) {
		this.#root = deps.root;
		this.#sessionId = deps.sessionId;
		this.#path = join(deps.root, "traces", `${deps.sessionId}.jsonl`);
	}

	/** One-time setup: mkdir the ledger dir, mark a previous run that left
	 *  no run_end (crash), write the header — the header once per ledger
	 *  file (session-level, §1.2), so a resume appends markers, never a
	 *  second header. Never throws. */
	init(): void {
		if (this.#degraded) return;
		try {
			mkdirSync(join(this.#root, "traces"), { recursive: true });
			const fresh = !existsSync(this.#path);
			if (this.#crashDetect()) {
				this.#writeSync([
					{ schemaVersion: TRACE_SCHEMA_VERSION, kind: "crash", ts: Date.now(), note: "previous run left no run_end" },
				]);
			}
			if (fresh) {
				this.#writeSync([
					{
						schemaVersion: TRACE_SCHEMA_VERSION,
						kind: "header",
						sessionId: this.#sessionId,
						kisoVersion: runtimeVersion() ?? "?",
						createdAt: Date.now(),
					},
				]);
			}
		} catch (err) {
			this.#degrade(err);
		}
	}

	/** Enqueue a line for the next flush — the hot path's only cost.
	 *  Never throws; after a degradation the line is dropped. */
	enqueue(line: TraceLine): void {
		if (this.#degraded) return;
		this.#pending.push(line);
		if (!this.#flushScheduled) {
			this.#flushScheduled = true;
			setImmediate(() => {
				this.#flushScheduled = false;
				this.#flushSync();
			});
		}
	}

	/** Clean-settle marking: the run_end line lands NOW (synchronous),
	 *  together with any still-pending request lines. */
	finishRun(runId: string, lastRequestIndex: number): void {
		this.enqueue({
			schemaVersion: TRACE_SCHEMA_VERSION,
			kind: "run_end",
			runId,
			ts: Date.now(),
			lastRequestIndex,
		});
		this.#flushSync();
	}

	/** True when the ledger already exists and its LAST line is neither
	 *  run_end nor crash — an un-terminated run (killed mid-run), to be
	 *  marked. A crash-marked ledger is not re-marked. */
	#crashDetect(): boolean {
		if (!existsSync(this.#path)) return false;
		let last: TraceLine | undefined;
		try {
			for (const line of readFileSync(this.#path, "utf8").split("\n")) {
				if (line.trim() === "") continue;
				last = JSON.parse(line) as TraceLine;
			}
		} catch {
			return false; // unreadable ledger — do not compound the failure
		}
		if (last === undefined) return false;
		return last.kind !== "run_end" && last.kind !== "crash";
	}

	#writeSync(lines: TraceLine[]): void {
		if (lines.length === 0) return;
		try {
			appendFileSync(this.#path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
		} catch (err) {
			this.#degrade(err);
		}
	}

	#flushSync(): void {
		if (this.#pending.length === 0) return;
		const lines = this.#pending;
		this.#pending = [];
		this.#writeSync(lines);
	}

	/** The soft-fail law: one stderr line, then the ledger is dropped and
	 *  the session runs on. Idempotent. */
	#degrade(err: unknown): void {
		if (this.#degraded) return;
		this.#degraded = true;
		this.#pending = [];
		console.error(`[kiso] trace writer degraded (${err instanceof Error ? err.message : String(err)}); request traces dropped`);
	}
}
