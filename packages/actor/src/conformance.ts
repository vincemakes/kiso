/**
 * ADR-0064 § 2.3 — the storage contract as executable checks. Any backend,
 * kiso's or a consumer's, must pass every one. No test framework: each check
 * throws on failure, so a consumer runs them under whatever runner it uses.
 */
import { LogLockedError, StaleRevisionError, type AppendLogBackend } from "./log.js";

export type ConformanceCheck = { readonly name: string; readonly run: () => Promise<void> };

function assert(condition: boolean, message: string): asserts condition {
	if (!condition) throw new Error(`conformance: ${message}`);
}

async function rejects(p: Promise<unknown>, type: new (...a: never[]) => Error, message: string): Promise<void> {
	try {
		await p;
	} catch (error) {
		assert(error instanceof type, `${message}: threw ${String(error)}`);
		return;
	}
	assert(false, `${message}: did not throw`);
}

/** `makeBackend` must return a backend over fresh, empty storage on every call. */
export function appendLogConformance(makeBackend: () => AppendLogBackend<{ readonly n: number }>): ConformanceCheck[] {
	return [
		{
			name: "a new log is empty, at revision -1",
			run: async () => {
				const w = await makeBackend().writer("a/work/x");
				assert(w.revision === -1 && w.lines().length === 0, "not empty");
				await w.close();
			},
		},
		{
			name: "appends are contiguous from 0 and return the new revision",
			run: async () => {
				const b = makeBackend();
				const w = await b.writer("a/work/x");
				assert((await w.append(-1, { n: 0 })) === 0, "first seq");
				assert((await w.append(0, { n: 1 })) === 1, "second seq");
				await w.close();
				const lines = await b.read("a/work/x");
				assert(lines.map((l) => l.seq).join() === "0,1" && lines[1]?.event.n === 1, "read back");
			},
		},
		{
			name: "an append against a stale revision is refused and writes nothing",
			run: async () => {
				const b = makeBackend();
				const w = await b.writer("a/work/x");
				await w.append(-1, { n: 0 });
				await rejects(w.append(-1, { n: 9 }), StaleRevisionError, "stale append");
				await w.close();
				assert((await b.read("a/work/x")).length === 1, "the stale append landed");
			},
		},
		{
			name: "one writer per log; another log is independent",
			run: async () => {
				const b = makeBackend();
				const w = await b.writer("a/work/x");
				await rejects(b.writer("a/work/x"), LogLockedError, "second writer");
				const other = await b.writer("a/work/y");
				await other.close();
				await w.close();
			},
		},
		{
			name: "close releases the writer; a new writer sees every committed line",
			run: async () => {
				const b = makeBackend();
				const w = await b.writer("a/work/x");
				await w.append(-1, { n: 0 });
				await w.close();
				const w2 = await b.writer("a/work/x");
				assert(w2.revision === 0 && w2.lines()[0]?.event.n === 0, "reopened state");
				await w2.close();
			},
		},
		{
			name: "a reader sees committed lines while a writer holds the log",
			run: async () => {
				const b = makeBackend();
				const w = await b.writer("a/work/x");
				await w.append(-1, { n: 0 });
				assert((await b.read("a/work/x")).length === 1, "reader during write");
				await w.close();
			},
		},
		{
			name: "a log that does not exist reads as no lines",
			run: async () => {
				assert((await makeBackend().read("a/work/none")).length === 0, "absent log");
			},
		},
	];
}
