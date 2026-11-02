import { kisoHome } from "@vincemakes/kiso-runtime";
import { tiersFor } from "@vincemakes/kiso-runtime/internal";
import { CODING_TOOL_RULES, composeSystemPrompt, SYSTEM_PROMPT } from "@vincemakes/kiso-code/policy";
import { createCodingTools } from "@vincemakes/kiso-tools-node";
import { promptOf, protectedFiles, type PermissionMode } from "./agent.js";
import type { ContextParts } from "../shared/settings.js";

/** What the Work's requests always carry, in bytes, for the rail's Context breakdown (an estimate the page labels as one), and where
 *  compaction starts and must happen for the stated window (the runtime's own tiers; null without a stated window). */
export function contextParts(workspace: string, tier: PermissionMode, window: number | null): ContextParts {
	const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
	const prompt = promptOf(workspace, tier);
	const instructions = Math.max(0, bytes(composeSystemPrompt(workspace, protectedFiles())) - bytes(SYSTEM_PROMPT));
	const tools = createCodingTools({ workspaceRoot: workspace, excludeRoots: [kisoHome()], secretEnvNames: [], protectedFiles: protectedFiles() });
	const tiers = window === null ? null : tiersFor(window, 0);
	return {
		system: bytes(prompt) - instructions + CODING_TOOL_RULES.reduce((n, r) => n + bytes(r.line) + 1, 0),
		instructions,
		tools: { count: tools.length, bytes: tools.reduce((n, t) => n + bytes(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })), 0) },
		compaction: tiers === null ? null : { starts: tiers.soft, must: tiers.hard },
	};
}
