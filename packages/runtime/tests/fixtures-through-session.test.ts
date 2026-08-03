/**
 * Acceptance: the accident library runs on the REAL runtime/session, not
 * just the bare loop. Each fixture drives an AgentSession (durable store,
 * write-ahead, execution ledger); the trajectory must satisfy the
 * fixture's assertions, terminal expectations, and delivery verdicts.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, FIXTURES, makeAbortSignal } from "@kiso/evals";
import { defineTool, type Event, type HookHost, type Tool } from "@kiso/core";
import { createAgent, SessionStore } from "../src/index.js";

/** Per-fixture wiring the incidents need (tools, hooks, signals). */
const WIRING: Record<string, { tools?: readonly Tool<any>[]; hooks?: HookHost; abortAfter?: number }> = {
	"silent-tool-failure": {
		tools: [
			defineTool({
				name: "web_search",
				description: "s",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "overloaded", isError: true, errorKind: "transient" as const }),
			}),
		],
	},
	"permission-negotiation": {
		tools: [
			defineTool({
				name: "code_execute",
				description: "run code",
				parameters: { type: "object", properties: {} },
				execute: async () => ({ content: "2", isError: false }),
			}),
		],
		hooks: {
			onPreTool: (() => {
				let approved = false;
				return async () => {
					if (!approved) {
						approved = true;
						return { action: "deny" as const, reason: "needs approval" };
					}
					return { action: "allow" as const };
				};
			})(),
		},
	},
	"user-abort": { abortAfter: 1 },
};

describe("incident fixtures on the real session runtime", () => {
	for (const fixture of FIXTURES) {
		it(`${fixture.name} passes through a durable session (${fixture.incident})`, async () => {
			const wiring = WIRING[fixture.name] ?? {};
			const store = new SessionStore(mkdtempSync(join(tmpdir(), "kiso-fix-")));
			const agent = createAgent({
				model: "faux",
				store,
				tools: wiring.tools ?? [],
				...(wiring.hooks !== undefined ? { hooks: wiring.hooks } : {}),
				adapter: createFauxProvider(fixture.script),
			});
			const session = await agent.session({ id: fixture.name });

			const events: Event[] = [];
			const abort = wiring.abortAfter !== undefined ? makeAbortSignal(0) : undefined;
			const run = session.run("fixture", abort !== undefined ? { signal: abort.signal } : undefined);
			for await (const ev of run) {
				events.push(ev);
				if (ev.type === "uncertain_pending") {
					// The human decides: the interrupted attempt did not apply.
					await session.resolveUncertain(ev.executionId, "abandoned");
				}
				if (abort !== undefined && events.length === wiring.abortAfter) {
					// The user-abort fixture's signal is flipped mid-run,
					// mirroring a user hitting stop.
					abort.flip();
				}
			}

			// The session trajectory is a superset of the loop's — the
			// fixture's own assertion must still hold over it.
			const violations = fixture.assert?.(events) ?? [];
			expect(violations, `${fixture.name}: ${violations.join("; ")}`).toEqual([]);

			// Terminal expectations hold through the session too.
			const terminal = events.find((e) => e.type === "terminal");
			if (fixture.requiredTerminal) {
				expect(terminal?.outcome.kind).toBeOneOf([...fixture.requiredTerminal]);
			}

			// Delivery truth is the fixture's own assertion (terminal-lies
			// REQUIRES the verdict to fail — the lie must be caught).

			// The trajectory is durable: reload and replay equals it.
			const reloaded = await agent.session({ id: fixture.name });
			// The reloaded log equals the SESSION's own log — the durable truth,
			// which includes session-appended records (resolutions) that are
			// not consumer-visible yields.
			expect(reloaded.log.all.map((e) => e.type)).toEqual(session.log.all.map((e) => e.type));
		});
	}
});
