/**
 * Graphite §7.10 — what the opening says loaded: the session, the
 * project's rules, the skills, the MCP servers, and the extensions. The
 * model, the mode and the folder are the status bar's (§8.9) and are not
 * repeated here — except the faux model, which the bar names but cannot
 * say how to leave.
 *
 * Pure over what the CLI already holds at startup; the banner lays the
 * facts out and knows nothing of where they came from.
 */

import type { BannerFact } from "@vincemakes/kiso-tui";

export interface OpeningInputs {
	/** The session's id — the SESSION row names it (the last sweep: the
	 *  `session <id>` line above the opening retired on a dock). Null off a
	 *  dock, where that line still prints: the row keeps its old form. */
	readonly sessionId: string | null;
	/** The events a resumed session opened with; 0 for a new one. */
	readonly resumedEvents: number;
	/** No model resolved and on a dock: the scripted faux model answers
	 *  (off a dock the `[faux mode — …]` line still prints). */
	readonly faux: boolean;
	/** The instruction file the prompt reads (`projectInstructions`), or null. */
	readonly rules: string | null;
	/** The skills catalog's size, or null when no skills extension loaded. */
	readonly skills: { readonly count: number; readonly broken: number } | null;
	/** The MCP extension's tools as they stand, or null when it is not loaded. */
	readonly mcp: { readonly tools: readonly string[]; readonly connecting: boolean } | null;
	/** The extensions — `extensionsFact`'s count and names, from the SAME
	 *  three lists the pipe's `[N extensions: …]` line is built from (so the
	 *  two still cannot disagree about what loaded, and the 0.40.0 `ask (off
	 *  in dontAsk)` note stays beside the tier that turns it off); null when
	 *  nothing loaded. The last sweep (owner, 2026-10-06): the row carried
	 *  the pipe's bracketed line verbatim — as it still does off a dock
	 *  (`{ value: <the line> }`). */
	readonly extensions: { readonly value: string; readonly note?: string } | null;
	/** DC-49 — the workspace is the home directory. */
	readonly homeWorkspace: boolean;
}

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

export function openingFacts(o: OpeningInputs): BannerFact[] {
	const facts: BannerFact[] = [];
	if (o.sessionId === null) facts.push(o.resumedEvents > 0 ? { label: "SESSION", value: "resumed", note: plural(o.resumedEvents, "event") } : { label: "SESSION", value: "new", note: "resumable after kill -9" });
	else facts.push({ label: "SESSION", value: o.sessionId, note: o.resumedEvents > 0 ? `resumed \u00b7 ${plural(o.resumedEvents, "event")}` : "new \u00b7 resumable after kill -9" });
	// the last sweep: no model resolved — the bar says `faux`, and this row
	// says how to leave it (the line that said so was painted over at once)
	// (as short as the RULES note: beside the wordmark a longer note is cut)
	if (o.faux) facts.push({ label: "MODEL", value: "faux", note: "set an API key, or add a model to config.json" });
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
	if (o.extensions !== null) facts.push({ label: "EXTENSIONS", value: o.extensions.value, ...(o.extensions.note !== undefined ? { note: o.extensions.note } : {}) });
	// DC-49: STATES the fact and names the remedy; it does not warn — the
	// configuration is allowed (owner, 2026-09-06)
	if (o.homeWorkspace) facts.push({ label: "", value: "home directory as workspace — cd into a project to narrow it" });
	return facts;
}
