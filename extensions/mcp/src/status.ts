/**
 * The bridge's own first-party status tool, in its OWN module so the
 * PH-1a.1 schema-inventory gate can import the definition WITHOUT the
 * package entrypoint growing a test seam (the published index.d.ts
 * declares only the factory). Bridged EXTERNAL schemas pass through
 * verbatim and are exempt from the closed world; this tool is not.
 */

import type { Tool } from "@vincemakes/kiso-core";
import type { ServerStatus } from "./index.js";

export function statusTool(status: readonly ServerStatus[]): Tool {
	return {
		name: "mcp__status",
		description: "list MCP server connection status",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		execute: async () => ({
			content: status
				.map((s) => {
					const tail = s.stderr?.tail();
					if (tail === undefined || tail === "") return `${s.server}: ${s.state} — ${s.detail}`;
					return `${s.server}: ${s.state} — ${s.detail}\n  stderr tail:\n${tail
						.trimEnd()
						.split("\n")
						.map((line) => `    ${line}`)
						.join("\n")}`;
				})
				.join("\n"),
			isError: false,
		}),
	};
}
