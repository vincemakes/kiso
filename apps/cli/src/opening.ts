/**
 * Graphite §7.10 — what the opening says loaded: the session, the
 * project's rules, the skills, the MCP servers, and any extension the
 * person or the project added. The model, the mode and the folder are the
 * status bar's (§8.9) and are not repeated here.
 *
 * Pure over what the CLI already holds at startup; the banner lays the
 * facts out and knows nothing of where they came from.
 */

import type { BannerFact } from "@vincemakes/kiso-tui";

export interface OpeningInputs {
	/** The events a resumed session opened with; 0 for a new one. */
	readonly resumedEvents: number;
	/** The instruction file the prompt reads (`projectInstructions`), or null. */
	readonly rules: string | null;
	/** The skills catalog's size, or null when no skills extension loaded. */
	readonly skills: { readonly count: number; readonly broken: number } | null;
	/** The MCP extension's tools as they stand, or null when it is not loaded. */
	readonly mcp: { readonly tools: readonly string[]; readonly connecting: boolean } | null;
	/** Extensions beyond the built-in ones, by where they came from. */
	readonly extensions: { readonly user: readonly string[]; readonly project: readonly string[] };
	/** DC-49 — the workspace is the home directory. */
	readonly homeWorkspace: boolean;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function openingFacts(o: OpeningInputs): BannerFact[] {
	const facts: BannerFact[] = [];
	facts.push(o.resumedEvents > 0 ? { label: "SESSION", value: "resumed", note: plural(o.resumedEvents, "event") } : { label: "SESSION", value: "new", note: "resumable after kill -9" });
	facts.push(o.rules !== null ? { label: "RULES", value: o.rules } : { label: "RULES", value: "none", note: "an AGENTS.md or CLAUDE.md here is read" });
	if (o.skills !== null) {
		facts.push({ label: "SKILLS", value: String(o.skills.count), note: o.skills.broken > 0 ? `${o.skills.broken} cannot load · /skills` : "/skills lists them" });
	}
	if (o.mcp !== null) {
		// the status tool is the extension's own, not a server's
		const served = o.mcp.tools.filter((t) => t.startsWith("mcp__") && t !== "mcp__status");
		const servers = new Set(served.map((t) => /^mcp__(.+?)__/.exec(t)?.[1] ?? t)).size;
		if (servers === 0) facts.push({ label: "MCP", value: o.mcp.connecting ? "connecting…" : "none" });
		else facts.push({ label: "MCP", value: plural(servers, "server"), note: `${plural(served.length, "tool")}${o.mcp.connecting ? " · connecting…" : ""}` });
	}
	const added = [...o.extensions.user, ...o.extensions.project.map((n) => `project: ${n}`)];
	if (added.length > 0) facts.push({ label: "EXTENSIONS", value: String(added.length), note: added.join(", ") });
	// DC-49: STATES the fact and names the remedy; it does not warn — the
	// configuration is allowed (owner, 2026-09-06)
	if (o.homeWorkspace) facts.push({ label: "", value: "home directory as workspace — cd into a project to narrow it" });
	return facts;
}
