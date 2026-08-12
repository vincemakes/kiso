// Server: the durable session behind an HTTP endpoint. Two requests, one
// session id — run 2 sees run 1's context (the projection), and both
// terminals land on disk. The server itself holds no state: the store is
// the state.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createAgent, SessionStore, type Event } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent = createAgent({
  model: "faux",
  tools: [],
  store: new SessionStore("./sessions-server"),
  adapter: createFauxProvider([
    { events: [{ type: "text_delta", text: "Hello from turn one." }, { type: "stop", reason: "end_turn" }] },
    { events: [{ type: "text_delta", text: " Hello again — turn two sees turn one." }, { type: "stop", reason: "end_turn" }] },
  ]),
});
await agent.session({ id: "web" });

const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const { prompt } = JSON.parse(body) as { prompt: string };
  const session = await agent.session({ id: "web" });
  const events: Event[] = [];
  for await (const ev of session.run(prompt)) events.push(ev);
  const text = events
    .filter((e): e is Event & { type: "text_delta" } => e.type === "text_delta")
    .map((e) => e.text)
    .join("");
  const terminal = events.find((e) => e.type === "terminal");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ text, terminal: terminal?.outcome.kind ?? "none" }));
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address() as AddressInfo;

const outcomes: string[] = [];
for (const prompt of ["Hello?", "And again?"]) {
  const res = await fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    body: JSON.stringify({ prompt }),
  });
  const data = (await res.json()) as { text: string; terminal: string };
  outcomes.push(data.terminal);
}
server.close();

if (outcomes.length !== 2 || outcomes.some((t) => t !== "completed")) {
  console.error(`server example failed: outcomes=${outcomes.join(",")}`);
  process.exit(1);
}
console.log(`[server] two requests, one durable session — ${outcomes.join(", ")}`);
