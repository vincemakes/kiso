// This file is the executable form of the README's "Using it" block.
// scripts/hero-check.mjs verifies they stay identical, modulo exactly
// three pinned substitutions (faux adapter -> anthropic adapter). The
// consumer smoke test also compiles and runs this file in a clean
// project against the installed tarballs — if the README's promise
// breaks, this file is what fails first.
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
  store: new SessionStore("./sessions"),          // append-only JSONL
  adapter: createFauxProvider([
    { events: [{ type: "tool_call_end", callId: "c1", name: "add", input: { a: 2, b: 3 } }, { type: "stop", reason: "tool_use" }] },
    { events: [{ type: "stop", reason: "end_turn" }] },
  ]),
});

const session = await agent.session({ id: "demo" });
for await (const ev of session.run("What is 2+3?")) {
  switch (ev.type) {
    case "text_delta": process.stdout.write(ev.text); break;
    case "terminal": console.log("\n", ev.outcome.kind); break;
  }
}
