/**
 * The in-memory reference backend: the storage contract with nothing else.
 * It runs the same conformance suite as the file backend, so the suite tests
 * the contract and not one backend's accidents.
 */
import { LogLockedError, StaleRevisionError, validLogId, type AppendLog, type AppendLogBackend, type LogLine } from "./log.js";

export class MemoryLogBackend<T> implements AppendLogBackend<T> {
	readonly #logs = new Map<string, LogLine<T>[]>();
	readonly #held = new Set<string>();

	async read(logId: string): Promise<readonly LogLine<T>[]> {
		return [...(this.#logs.get(logId) ?? [])];
	}

	async writer(logId: string): Promise<AppendLog<T>> {
		if (!validLogId(logId)) throw new Error(`invalid log id: ${logId}`);
		if (this.#held.has(logId)) throw new LogLockedError(logId);
		this.#held.add(logId);
		const lines = this.#logs.get(logId) ?? [];
		this.#logs.set(logId, lines);
		let closed = false;
		return {
			lines: () => lines,
			get revision() {
				return lines.length - 1;
			},
			append: async (expectedRevision, event) => {
				if (closed) throw new Error(`log ${logId} is closed`);
				if (expectedRevision !== lines.length - 1) throw new StaleRevisionError(expectedRevision, lines.length - 1);
				lines.push({ seq: lines.length, ts: Date.now(), event });
				return lines.length - 1;
			},
			close: async () => {
				if (!closed) this.#held.delete(logId);
				closed = true;
			},
		};
	}
}
