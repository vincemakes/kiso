// Headless: the API-only shape — no rendering, no console. Types first:
// Agent / Session / Run / Event are the canonical names of the curated
// root manifest (docs/sdk.md). This is the shape a batch job or a test
// harness uses: collect the run, assert the terminal, move on.
import { createAgent, SessionStore, type Agent, type Event, type Run, type Session } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent: Agent = createAgent({
  model: "faux",
  tools: [],
  store: new SessionStore("./sessions-headless"),
  adapter: createFauxProvider([
    { events: [{ type: "text_delta", text: "2+3 is 5." }, { type: "stop", reason: "end_turn" }] },
  ]),
});

const session: Session = await agent.session({ id: "headless" });
const run: Run = session.run("What is 2+3?");
const events: Event[] = [];
for await (const ev of run) events.push(ev);

const terminal = events.find((e) => e.type === "terminal");
if (terminal?.outcome.kind !== "completed") {
  console.error(`headless example failed: terminal=${terminal?.outcome.kind}`);
  process.exit(1);
}
console.log(`[headless] ${events.length} durable events, terminal ${terminal.outcome.kind}`);
