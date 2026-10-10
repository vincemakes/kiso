/**
 * The program sandbox: a model-written script in QuickJS (WebAssembly), with no
 * ambient authority. The script reaches the outside world only through four
 * things the host gives it:
 *
 *   tools.<name>(args)      one tool call, run THROUGH THE KERNEL by `host.invoke`
 *                           (validation, approval chain, write-ahead, receipt);
 *                           resolves to the parsed JSON result, rejects with an Error
 *   ALL_TOOLS / searchTools / describeTool   discovery, from `host.catalog`
 *   text(v) / console.log   output
 *   return v                the result
 *
 * There is no `process`, `require`, `fetch`, timer, filesystem or network. The
 * bounds (invariant I13) are the host's: a wall budget, a memory limit, a call
 * budget; and the host's abort signal ends the script.
 *
 * A failed script reports the calls that had already completed and says they
 * are NOT undone (tool effects are real) — the model must not guess.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QuickJS } from "quickjs-wasi";
import type { ToolResult, ToolSpec } from "@vincemakes/kiso-core";

export interface ProgramHost {
	/** Run one tool through the kernel as a child of the running program. */
	invoke(name: string, input: Record<string, unknown>): Promise<ToolResult>;
	catalog(): readonly ToolSpec[];
	readonly signal: { readonly aborted: boolean; addEventListener(type: "abort", fn: () => void, opts?: { once: boolean }): void };
}

export interface ProgramLimits {
	readonly timeoutMs?: number;
	readonly memoryBytes?: number;
	readonly maxCalls?: number;
	readonly maxOutputChars?: number;
}

export interface ProgramResult {
	readonly ok: boolean;
	/** What the model sees (header, value, text items, console lines, errors, calls made). */
	readonly output: string;
	/** JSON of the script's `return` value, when it returned one. */
	readonly value?: string;
	/** Tool calls that completed, in order of completion. */
	readonly calls: readonly { readonly name: string; readonly ok: boolean }[];
	readonly fullOutputPath?: string;
}

const DEFAULTS = { timeoutMs: 60_000, memoryBytes: 64 * 1024 * 1024, maxCalls: 200, maxOutputChars: 20_000 } as const;

let wasm: Promise<WebAssembly.Module> | undefined;
const wasmModule = (): Promise<WebAssembly.Module> =>
	(wasm ??= WebAssembly.compile(readFileSync(createRequire(import.meta.url).resolve("quickjs-wasi/quickjs.wasm"))));

/** Runs inside the VM, once, before the script. Nothing here touches the host except `__call`. */
const PRELUDE = `
(() => {
	const out = [], logs = [];
	const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v));
	globalThis.__out = out; globalThis.__logs = logs;
	globalThis.text = (v) => { out.push(fmt(v)); };
	const log = (...a) => { logs.push(a.map(fmt).join(" ")); };
	globalThis.console = { log, info: log, warn: log, error: log, debug: log };
	const call = globalThis.__call; delete globalThis.__call;
	globalThis.tools = new Proxy({}, {
		get: (_, name) => (typeof name !== "string" ? undefined : async (args) => {
			const r = JSON.parse(await call(name, JSON.stringify(args === undefined ? {} : args)));
			if (!r.ok) throw new Error(r.error);
			return r.value;
		}),
	});
	const catalog = JSON.parse(globalThis.__catalog); delete globalThis.__catalog;
	globalThis.ALL_TOOLS = catalog.map((t) => ({ name: t.name, description: t.description }));
	globalThis.describeTool = async (name) => catalog.find((t) => t.name === name);
	const words = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));
	globalThis.searchTools = async (query, opts) => {
		const q = words(query), limit = (opts && opts.limit) || 8;
		return catalog
			.map((t, i) => { const n = words(t.name), d = words(t.description); return { t, i, s: q.reduce((a, w) => a + (n.includes(w) ? 2 : 0) + (d.includes(w) ? 1 : 0), 0) }; })
			.filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, limit)
			.map((x) => ({ name: x.t.name, description: x.t.description }));
	};
})();
`;

const parseResult = (content: string): unknown => {
	try { return JSON.parse(content); } catch { return content; }
};

export async function runProgram(code: string, host: ProgramHost, limits: ProgramLimits = {}): Promise<ProgramResult> {
	const L = { ...DEFAULTS, ...limits };
	const started = Date.now();
	const deadline = started + L.timeoutMs;
	const calls: { name: string; ok: boolean }[] = [];
	let issued = 0;
	let disposed = false;
	let stop: string | null = null; // why the host ended the script
	const vm = await QuickJS.create({ wasm: await wasmModule(), memoryLimit: L.memoryBytes, interruptHandler: () => stop !== null || Date.now() > deadline || host.signal.aborted });
	const cleanups: (() => void)[] = [];
	let verdict: { ok: boolean; value?: string; error?: string };
	let logs: string[] = [], texts: string[] = [];
	try {
		{
			using fn = vm.newFunction("__call", (nameH, argsH) => {
				const name = nameH.toString();
				const deferred = vm.newPromise();
				const settle = (payload: unknown): void => {
					if (disposed) return;
					deferred.resolve(vm.newString(JSON.stringify(payload)));
					vm.executePendingJobs();
				};
				if (issued >= L.maxCalls) {
					settle({ ok: false, error: `program call budget exhausted (${L.maxCalls} calls)` });
					return deferred.handle;
				}
				issued += 1;
				let input: Record<string, unknown> = {};
				try { input = JSON.parse(argsH.toString()) as Record<string, unknown>; } catch { /* {} */ }
				host.invoke(name, input).then(
					(r) => { calls.push({ name, ok: !r.isError }); settle(r.isError ? { ok: false, error: r.content } : { ok: true, value: parseResult(r.content) }); },
					(e: unknown) => { calls.push({ name, ok: false }); settle({ ok: false, error: e instanceof Error ? e.message : String(e) }); },
				);
				return deferred.handle;
			});
			vm.setProp(vm.global, "__call", fn);
		}
		{
			using cat = vm.newString(JSON.stringify(host.catalog().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))));
			vm.setProp(vm.global, "__catalog", cat);
		}
		vm.evalCode(PRELUDE, "prelude.js").dispose();
		vm.evalCode(
			`globalThis.__run = async () => { try { const __v = await (async () => {\n${code}\n})(); return JSON.stringify({ ok: true, value: __v === undefined ? undefined : JSON.stringify(__v) }); } catch (e) { return JSON.stringify({ ok: false, error: e && e.message ? String(e.message) : String(e) }); } };`,
			"program.js",
		).dispose();
		const outcome = await new Promise<{ ok: boolean; value?: string; error?: string }>((resolve) => {
			const timer = setTimeout(() => { stop = "time budget exhausted"; resolve({ ok: false, error: `time budget exhausted (${L.timeoutMs} ms)` }); }, Math.max(1, deadline - Date.now()));
			const onAbort = (): void => { stop = "aborted"; resolve({ ok: false, error: "aborted" }); };
			if (host.signal.aborted) onAbort(); else host.signal.addEventListener("abort", onAbort, { once: true });
			cleanups.push(() => clearTimeout(timer));
			void (async () => {
				try {
					using promise = vm.evalCode("__run()", "run.js");
					vm.executePendingJobs(); // a script that never awaits the host settles on the job queue alone
					const res = (await vm.resolvePromise(promise)) as { value?: { dispose(): void }; error?: { dispose(): void } };
					if (res.value === undefined) throw new Error("the script's promise rejected");
					const text = vm.dump(res.value as never) as string;
					res.value.dispose();
					resolve(JSON.parse(text) as { ok: boolean; value?: string; error?: string });
				} catch (e) {
					resolve({ ok: false, error: e instanceof Error && /interrupt/i.test(e.message) ? `interrupted (${stop ?? "time budget"})` : `sandbox error: ${e instanceof Error ? e.message : String(e)}` });
				}
			})();
		});
		verdict = outcome;
		if (!disposed && stop === null) {
			try {
				using o = vm.evalCode("JSON.stringify({ out: __out, logs: __logs })");
				const got = JSON.parse(o.toString()) as { out: string[]; logs: string[] };
				texts = got.out; logs = got.logs;
			} catch { /* output not readable after a fault */ }
		}
	} catch (e) {
		verdict = { ok: false, error: `sandbox error: ${e instanceof Error ? e.message : String(e)}` };
	} finally {
		for (const c of cleanups) c();
		disposed = true;
		try { vm.dispose(); } catch { /* already gone */ }
	}

	const lines: string[] = [`${verdict.ok ? "Script completed" : "Script failed"} (${calls.length} tool call${calls.length === 1 ? "" : "s"}, ${Date.now() - started} ms)`];
	if (verdict.value !== undefined) {
		const parsed = JSON.parse(verdict.value) as unknown;
		lines.push(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2));
	}
	for (const t of texts) lines.push(t);
	if (logs.length > 0) lines.push("<console_output>", ...logs, "</console_output>");
	if (!verdict.ok) {
		lines.push(`Script error: ${verdict.error ?? "unknown"}`);
		if (calls.length > 0) lines.push(`Calls that had already completed before the failure (tool effects are NOT undone): ${calls.map((c) => `${c.name} ${c.ok ? "ok" : "error"}`).join(", ")}`);
	}
	let output = lines.join("\n");
	let fullOutputPath: string | undefined;
	if (output.length > L.maxOutputChars) {
		fullOutputPath = join(tmpdir(), `kiso-program-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
		writeFileSync(fullOutputPath, output);
		const head = Math.floor(L.maxOutputChars * 0.6), tail = L.maxOutputChars - head;
		output = `${output.slice(0, head)}\n…[output truncated: ${output.length - L.maxOutputChars} characters omitted; the full text is in ${fullOutputPath}]…\n${output.slice(-tail)}`;
	}
	return { ok: verdict.ok, output, ...(verdict.value !== undefined ? { value: verdict.value } : {}), calls, ...(fullOutputPath !== undefined ? { fullOutputPath } : {}) };
}
