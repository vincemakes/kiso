// Resume: the "survives kill -9" story. The first run's loop breaks after
// the draft delta — NO abort, NO terminal: the process "dies" mid-turn.
// The draft is already on disk (persist-first). A fresh store + session
// (a fresh process in real life) recovers the open run: the kernel writes
// model_output_abandoned, the projection voids the draft range, and the
// run continues to its terminal.
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";

const script: FauxScript = [
  { events: [{ type: "text_delta", text: "Computing" }, { type: "stop", reason: "end_turn" }] },
  { events: [{ type: "text_delta", text: " the answer is 42." }, { type: "stop", reason: "end_turn" }] },
];

const store = new SessionStore("./sessions-resume");
const agent1 = createAgent({ model: "faux", tools: [], store, adapter: createFauxProvider(script) });
const session1 = await agent1.session({ id: "resume" });
for await (const ev of session1.run("What is the answer?")) {
  if (ev.type === "text_delta") break; // ← the process dies here
}
store.closeAll(); // the dying process releases its locks

// A fresh store + session (a fresh process in real life) recovers the run.
const agent2 = createAgent({
  model: "faux",
  tools: [],
  store: new SessionStore("./sessions-resume"),
  adapter: createFauxProvider(script),
});
const session2 = await agent2.session({ id: "resume" });
let voided = false;
let terminal: string | null = null;
for await (const ev of session2.resume()) {
  if (ev.type === "model_output_abandoned") voided = true;
  if (ev.type === "terminal") terminal = ev.outcome.kind;
}
if (!voided || terminal !== "completed") {
  console.error(`resume example failed: voided=${voided} terminal=${terminal}`);
  process.exit(1);
}
console.log(`[resume] draft voided, trajectory continued — ${terminal}`);
