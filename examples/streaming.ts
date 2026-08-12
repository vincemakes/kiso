// Streaming: render events AS THEY LAND — the shape a TUI, a web view, or
// a log tail uses. One event at a time, in seq order; every event is
// already on disk before this loop sees it (persist-first). Control facts
// (usage, stop, terminal) render nothing here — they are the stream's
// punctuation, not its content.
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent = createAgent({
  model: "faux",
  tools: [],
  store: new SessionStore("./sessions-streaming"),
  adapter: createFauxProvider([
    { events: [
      { type: "text_delta", text: "Let me think about this." },
      { type: "text_delta", text: " The answer is 42." },
      { type: "stop", reason: "end_turn" },
    ] },
  ]),
});

const session = await agent.session({ id: "stream" });
let terminal: string | null = null;
for await (const ev of session.run("What is the answer?")) {
  switch (ev.type) {
    case "text_delta": process.stdout.write(ev.text); break;
    case "usage": process.stdout.write(` [tokens ${ev.inputTokens}/${ev.outputTokens}]`); break;
    case "terminal": terminal = ev.outcome.kind; break;
  }
}
process.stdout.write("\n");
if (terminal !== "completed") {
  console.error(`streaming example failed: terminal=${terminal}`);
  process.exit(1);
}
console.log(`[streaming] rendered as it landed — terminal ${terminal}`);
