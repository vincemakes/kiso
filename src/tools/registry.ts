/**
 * L3 — the tool registry.
 *
 * One registry per agent. It is the ONLY place the kernel learns which tools
 * exist: nothing is assembled from a list maintained elsewhere, because a
 * second list is a second truth (the failure class behind Claude Code's five
 * hand-maintained agent-tool sets and pi's six copies of the default tool
 * list — see ADR-0001).
 *
 * `subset()` is the structural tool filter: a mode or a subagent gets a
 * registry whose tool table PHYSICALLY lacks the tools it must not see. The
 * model cannot call a tool that is not in its registry — no prompt can
 * achieve that guarantee.
 */

import type { ToolSpec } from "../protocol/messages";
import type { Tool } from "./tool";

export class ToolRegistry {
	readonly #tools = new Map<string, Tool>();

	register(tool: Tool<any>): void {
		if (this.#tools.has(tool.name)) {
			throw new Error(`Tool already registered: ${tool.name}`);
		}
		this.#tools.set(tool.name, tool);
	}

	get(name: string): Tool<any> | undefined {
		return this.#tools.get(name);
	}

	list(): readonly Tool[] {
		return [...this.#tools.values()];
	}

	has(name: string): boolean {
		return this.#tools.has(name);
	}

	/** A registry restricted to the named tools. Unknown names are dropped
	 *  loudly (the kernel never silently shrinks a tool set). */
	subset(names: readonly string[]): ToolRegistry {
		const out = new ToolRegistry();
		for (const name of names) {
			const tool = this.#tools.get(name);
			if (tool === undefined) {
				throw new Error(`subset(): unknown tool '${name}'`);
			}
			out.register(tool);
		}
		return out;
	}

	/** The minimal projection an adapter may see (never the handlers). */
	toSpecs(): readonly ToolSpec[] {
		return [...this.#tools.values()].map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: t.parameters,
		}));
	}
}
