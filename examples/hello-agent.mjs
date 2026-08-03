// The README example, as an executable file. The consumer smoke test runs
// this exact code in a clean project against the installed tarballs — if
// the README's promise breaks, this file is what fails first.
import { defineTool } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent = createAgent({
  model: "faux",
  tools: [
    defineTool({
      name: "add",
      description: "Add two numbers",
      parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
      execute: async ({ a, b }) => ({ content: String(a + b), isError: false }),
    }),
  ],
  store: new SessionStore("./sessions"),
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } }, { type: "stop", reason: "tool_use" }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
});

const session = await agent.session({ id: "hello" });
for await (const ev of session.run("What is 2+3?")) {
  if (ev.type === "text_delta") process.stdout.write(ev.text);
  if (ev.type === "terminal") console.log("\n", ev.outcome.kind);
}
