// Web: the durable session as a shareable HTML artifact — a static render
// of the trajectory (deltas rendered, control facts invisible) written to
// disk. The same projection a live web view would stream; here it lands
// as a file a human can open.
import { readFileSync, writeFileSync } from "node:fs";
import { createAgent, SessionStore, type Event } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent = createAgent({
  model: "faux",
  tools: [],
  store: new SessionStore("./sessions-web"),
  adapter: createFauxProvider([
    { events: [{ type: "text_delta", text: "Here is the summary." }, { type: "stop", reason: "end_turn" }] },
  ]),
});

const session = await agent.session({ id: "web" });
const events: Event[] = [];
for await (const ev of session.run("Summarize the work")) events.push(ev);

const text = events
  .filter((e): e is Event & { type: "text_delta" } => e.type === "text_delta")
  .map((e) => e.text)
  .join("");
const terminal = events.find((e) => e.type === "terminal");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>kiso session</title>
<style>body{font:16px/1.5 system-ui;max-width:52rem;margin:3rem auto;padding:0 1rem}
.say{border-left:3px solid #345;padding-left:.75rem}.term{color:#678}</style>
</head><body><h1>session: web</h1>
<p class="say">${text}</p><p class="term">terminal: ${terminal?.outcome.kind ?? "none"}</p>
</body></html>`;
writeFileSync("trajectory.html", html);

if (terminal?.outcome.kind !== "completed" || !readFileSync("trajectory.html", "utf8").includes(text)) {
  console.error(`web example failed: terminal=${terminal?.outcome.kind}`);
  process.exit(1);
}
console.log(`[web] trajectory.html written — terminal ${terminal.outcome.kind}`);
