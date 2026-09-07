/**
 * L3 — the tool registry.
 *
 * One registry per agent. It is the ONLY place the kernel learns which tools
 * exist: nothing is assembled from a list maintained elsewhere, because a
 * second list is a second truth (the failure class behind the reference
 * implementation's hand-maintained agent-tool sets and its six copies of the
 * default tool list — see ADR-0001).
 *
 * `subset()` is the structural tool filter: a mode or a subagent gets a
 * registry whose tool table PHYSICALLY lacks the tools it must not see. The
 * model cannot call a tool that is not in its registry — no prompt can
 * achieve that guarantee.
 *
 * `registerLive()` adds a LIVE tool source — a function returning an
 * extension's CURRENT tools array. Any extension whose tool table settles
 * after load is such a source (the runtime registers every extension's
 * table this way — agent.ts; a bridge that connects in the background was
 * the first to need it, 0.1.26); the registry consults the live sources
 * on every lookup. The registered map wins a name collision
 * (the agent's built-ins are authoritative); the collision check that
 * would otherwise fire at registration time cannot run against a live,
 * still-growing source.
 */

import type { ToolSpec } from "../protocol/messages.js";
import type { Tool } from "./tool.js";

/** CX-1 F7: a captured tool table — what ONE request advertises and
 *  dispatches from. */
export interface ToolTable {
	readonly specs: readonly ToolSpec[];
	get(name: string): Tool<any> | undefined;
}

export class ToolRegistry {
	readonly #tools = new Map<string, Tool>();
	readonly #live: { readonly source: () => readonly Tool[]; readonly owner: string }[] = [];

	register(tool: Tool<any>): void {
		if (this.#tools.has(tool.name)) {
			throw new Error(`Tool already registered: ${tool.name}`);
		}
		this.#tools.set(tool.name, tool);
	}

	/** 0.1.26: a live tool source — consulted on every lookup, never
	 *  snapshotted. The source returns the CURRENT array (it may grow). */
	registerLive(source: () => readonly Tool[], owner = `live#${this.#live.length + 1}`): void {
		this.#live.push({ source, owner });
	}

	/** CX-1 F7 (audit F7) — ONE table per request. The loop takes a
	 *  snapshot at request assembly and dispatches from it: the definition
	 *  sent to the model, the schema validated against, the `execute` that
	 *  runs and the `effects` the scheduler reads are the SAME captured
	 *  values: the declaration data (schema, effects) is COPIED into the
	 *  table, the handler stays by reference — an in-place edit to the
	 *  source after the snapshot cannot reach a request already under way
	 *  (the 2026-09-07 review's P2: a shallow copy shared the nested
	 *  objects). Two sources publishing one name is an error the moment
	 *  it is observed, naming both owners — never a traversal-order pick;
	 *  the one exception is the SAME Tool object reached twice (the 0.1.27
	 *  dedup), which is one tool. */
	snapshot(): ToolTable {
		const captured = new Map<string, { tool: Tool; original: Tool; owner: string }>();
		const take = (t: Tool, owner: string): void => {
			const prior = captured.get(t.name);
			if (prior !== undefined) {
				if (prior.original === t) return; // the same object reached twice — one tool
				throw new Error(`tool table: '${t.name}' is published by two sources (${prior.owner}, ${owner})`);
			}
			const copy = { ...t, parameters: structuredClone(t.parameters), ...(t.effects === undefined ? {} : { effects: Object.freeze(structuredClone(t.effects)) }) };
			captured.set(t.name, { tool: Object.freeze(copy) as Tool, original: t, owner });
		};
		for (const t of this.#tools.values()) take(t, "registered");
		for (const { source, owner } of this.#live) for (const t of source()) take(t, owner);
		const specs: ToolSpec[] = [...captured.values()].map(({ tool: t }) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
		return { specs, get: (name) => captured.get(name)?.tool };
	}

	get(name: string): Tool<any> | undefined {
		const t = this.#tools.get(name);
		if (t !== undefined) return t;
		for (const { source } of this.#live) {
			const found = source().find((x) => x.name === name);
			if (found !== undefined) return found;
		}
		return undefined;
	}

	list(): readonly Tool[] {
		// The registered map WINS a name collision against a live source —
		// the same rule get()/has() already follow, applied here too
		// (0.1.27 the disqualification investigation: the agent eagerly registers a sync extension's
		// tools AND registers its live source — a skills/subagent/MCP status
		// tool appeared twice in toSpecs() and the real API answered
		// "400 Tool names must be unique"; the identity is the same object,
		// so the dedup changes nothing behaviorally).
		const seen = new Set<string>();
		const out: Tool[] = [];
		for (const t of this.#tools.values()) {
			seen.add(t.name);
			out.push(t);
		}
		for (const { source } of this.#live) {
			for (const t of source()) {
				if (!seen.has(t.name)) {
					seen.add(t.name);
					out.push(t);
				}
			}
		}
		return out;
	}

	has(name: string): boolean {
		if (this.#tools.has(name)) return true;
		return this.#live.some(({ source }) => source().some((x) => x.name === name));
	}

	/** A registry restricted to the named tools. Unknown names are dropped
	 *  loudly (the kernel never silently shrinks a tool set). */
	subset(names: readonly string[]): ToolRegistry {
		const out = new ToolRegistry();
		for (const name of names) {
			const tool = this.get(name);
			if (tool === undefined) {
				throw new Error(`subset(): unknown tool '${name}'`);
			}
			out.register(tool);
		}
		return out;
	}

	/** The minimal projection an adapter may see (never the handlers). */
	toSpecs(): readonly ToolSpec[] {
		return this.list().map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.parameters,
		}));
	}
}
