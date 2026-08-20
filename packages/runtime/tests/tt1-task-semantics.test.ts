/**
 * TT-1A — task_set's semantics, said out loud (RED before GREEN).
 *
 * ① HONESTY: task_set is a pure parse→echo, yet an invalid_input
 *    refusal today carries the kernel's "side effects may have
 *    partially applied" note — a false statement about a tool with no
 *    effects. `idempotent: true` (the ask_user precedent) makes the
 *    kernel's note honest by making the declaration true.
 * ② SCHEDULING: a pure echo satisfies `concurrency: "shared"` — a
 *    TODO update stops blocking the sibling FIFO queue. precommitSafe
 *    stays REJECTED (the adjudication): task_set waits for Turn
 *    Commit; TV-1C's projection gate exists, and speculative is still
 *    parked until a measured bottleneck. The absence is load-bearing
 *    and asserted.
 * ③ APPROVALS: the extension speaks for its own tool — allow
 *    task_set, abstain on everything else. The chain is
 *    deny > allow > ask (W21/R3): the allow heals the 0.14.0 dogfood
 *    finding (an all-abstain chain ASKS — nobody had spoken for
 *    task_set), and can never un-deny another speaker's deny.
 */

import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import { EventLog, loop, ToolRegistry, type Event, type PolicyVerdict } from "@vincemakes/kiso-core";
import createTaskExtension from "@vincemakes/kiso-task-ext";
import { composeApprovalChain } from "../src/compose.js";
import type { KisoExtension } from "../src/index.js";

// the factory is synchronous in fact; the contract union merely PERMITS
// async factories — narrowed once here
const taskExt = (): KisoExtension => createTaskExtension() as KisoExtension;

function registryWithTask(): ToolRegistry {
	const registry = new ToolRegistry();
	for (const t of taskExt().tools ?? []) registry.register(t as never);
	return registry;
}

function scriptedTaskSet(items: { text: string; status: string }[]): FauxScript {
	return [
		{ events: [{ type: "tool_call_end", callId: "t1", name: "task_set", input: { items } }, { type: "stop", reason: "tool_use" }] },
		{ events: [{ type: "stop", reason: "end_turn" }] },
	];
}

async function drain(events: AsyncIterable<Event>): Promise<void> {
	for await (const _ of events) {
		/* drain — no human in the arc */
	}
}

const TWO_ACTIVE = [
	{ text: "one", status: "active" },
	{ text: "two", status: "active" },
];
const ONE_DONE = [{ text: "one", status: "done" }];

describe("TT-1A ① — the certificate matrix (and the rejection that is part of the ruling)", () => {
	const tool = (taskExt().tools ?? []).find((t) => t.name === "task_set")!;

	it("task_set declares idempotent — a pure parse→echo may honestly say so", () => {
		expect(tool.idempotent).toBe(true);
	});

	it("task_set declares concurrency shared — a pure echo never contends", () => {
		expect(tool.effects?.concurrency).toBe("shared");
	});

	it("task_set does NOT declare precommitSafe — the claim waits for Turn Commit (the adjudicated rejection)", () => {
		expect(tool.effects?.precommitSafe).toBeUndefined();
	});
});

describe("TT-1A ② — an invalid_input refusal carries no false side-effect note", () => {
	it("two actives are refused loudly, and the refusal does not say 'may have partially applied'", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "plan it" });
		await drain(
			loop({
				log,
				model: "faux",
				registry: registryWithTask(),
				adapter: createFauxProvider(scriptedTaskSet(TWO_ACTIVE)),
			}),
		);
		const failed = log.all.find((e): e is Event & { type: "tool_execution_failed" } => e.type === "tool_execution_failed");
		expect(failed).toBeDefined();
		expect(failed!.errorKind).toBe("invalid_input");
		expect(failed!.error).toContain("at most one active item");
		expect(failed!.error).not.toContain("may have partially applied");
	});
});

describe("TT-1A ③ — the extension speaks for its own tool, and only its own", () => {
	const abstainer = {
		name: "bystander",
		approvals: [{ decide: (): PolicyVerdict => ({ action: "abstain" }) }],
	};

	it("with a chain present, task_set auto-approves as the TASK extension's own decision — no human pause", async () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "plan it" });
		await drain(
			loop({
				log,
				model: "faux",
				registry: registryWithTask(),
				adapter: createFauxProvider(scriptedTaskSet(ONE_DONE)),
				approvalPolicy: composeApprovalChain([abstainer, taskExt()] as never)!,
			}),
		);
		const decided = log.all.filter((e): e is Event & { type: "permission_decided" } => e.type === "permission_decided");
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({ decision: "approved", decidedBy: "task" });
		// and the echo actually ran — the plan is durable
		const ok = log.all.find((e) => e.type === "tool_execution_succeeded");
		expect(ok).toBeDefined();
	});

	it("the allow cannot un-deny: another speaker's deny still wins over the task extension's allow", async () => {
		const denier = {
			name: "guard",
			approvals: [
				{
					decide: (call: { name: string }): PolicyVerdict =>
						call.name === "task_set" ? { action: "deny", reason: "not in this mode" } : { action: "abstain" },
				},
			],
		};
		const log = new EventLog();
		log.append({ type: "user_input", content: "plan it" });
		await drain(
			loop({
				log,
				model: "faux",
				registry: registryWithTask(),
				adapter: createFauxProvider(scriptedTaskSet(ONE_DONE)),
				approvalPolicy: composeApprovalChain([denier, taskExt()] as never)!,
			}),
		);
		const decided = log.all.filter((e): e is Event & { type: "permission_decided" } => e.type === "permission_decided");
		expect(decided).toHaveLength(1);
		expect(decided[0]).toMatchObject({ decision: "denied", decidedBy: "guard" });
		expect(log.all.some((e) => e.type === "tool_execution_started")).toBe(false);
	});
});
