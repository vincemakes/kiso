// Approvals: a permission-gated tool pauses the run until a human
// decides. The run yields permission_requested and WAITS — the decision
// (session.approve) is the durable answer, recorded before the tool ever
// executes. This example stands in for the human (an auto-approver); a
// real UI prompts, a CLI asks, and the run continues either way.
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore, type ApprovalRequest } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent = createAgent({
  model: "faux",
  tools: [
    defineTool({
      name: "deploy",
      description: "Deploy the service",
      parameters: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
      execute: async ({ env }) => ({ content: `deployed to ${env}`, isError: false }),
    }),
  ],
  permissionPolicy: { rules: [{ tool: "deploy", action: "defer" }] },
  store: new SessionStore("./sessions-approvals"),
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "c1", name: "deploy", input: { env: "prod" } }, { type: "stop", reason: "tool_use" }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
});

const session = await agent.session({ id: "approvals" });
const asked: ApprovalRequest[] = [];
let terminal: string | null = null;
for await (const ev of session.run("Deploy to prod")) {
  if (ev.type === "permission_requested") {
    // the human's decision, standing in for a real prompt
    await session.approve(ev.decisionId, true, "release window is open");
    asked.push(ev);
  }
  if (ev.type === "terminal") terminal = ev.outcome.kind;
}
if (asked.length !== 1 || terminal !== "completed") {
  console.error(`approvals example failed: asked=${asked.length} terminal=${terminal}`);
  process.exit(1);
}
console.log(`[approvals] one deferred call, one human decision, run ${terminal}`);
