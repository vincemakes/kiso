# Getting started — kiso in ten minutes

kiso is a durable multi-turn agent runtime: sessions that survive process
death, an append-only event log you can inspect, and a small, curated
public SDK. This walkthrough embeds kiso into a brand-new Node project.
It is the written form of the round's dogfood exercise — the ten-minute
judgment applies.

## 0. Requirements

- Node ≥ 22, npm ≥ 10.
- No API keys — this walkthrough uses the faux provider (`kiso-evals`),
  a deterministic event script. Swap in a real provider for the same
  shape with zero code changes beyond the adapter line.

## 1. Install (1 minute)

```sh
mkdir kiso-embed && cd kiso-embed
npm init -y
npm install @vincemakes/kiso-core @vincemakes/kiso-runtime @vincemakes/kiso-evals
```

## 2. First agent (4 minutes)

`hello.ts` — the shortest honest loop. The store is the session's only
state; `./sessions` is an append-only JSONL directory.

```ts
import { createAgent, SessionStore } from "@vincemakes/kiso-runtime";
import { createFauxProvider } from "@vincemakes/kiso-evals";

const agent = createAgent({
  model: "faux",
  tools: [],
  store: new SessionStore("./sessions"),
  adapter: createFauxProvider([
    { events: [{ type: "text_delta", text: "Hello from kiso." }, { type: "stop", reason: "end_turn" }] },
  ]),
});

const session = await agent.session({ id: "demo" });
for await (const ev of session.run("Hello?")) {
  if (ev.type === "terminal") console.log(ev.outcome.kind); // "completed"
}
```

```sh
npx tsx hello.ts
```

## 3. The three moves (3 minutes)

- **`agent.session({ id })`** — open (or create) a durable session. The id
  is the store key: the same id in a later process is the same session.
- **`session.run(input)`** — an async iterable of `Event`, in seq order,
  persist-first: every event is on disk before you see it. The run ends
  with exactly one `terminal` event — the honest terminal.
- **`session.resume()`** — recover the last *open* run (one that died
  before its terminal). Draft output is voided by `model_output_abandoned`
  and the run continues to its terminal.

That is the whole runtime. Permissions, tools, extensions, and the rest
are config, not new mechanics.

## 4. Run the real examples (2 minutes)

The repository ships seven executable examples (`examples/`), each a real
run on the faux provider with a self-asserted terminal:

| example | what it demonstrates |
|---|---|
| `hello-agent.ts` | the README hero, verbatim |
| `streaming.ts` | render events as they land |
| `headless.ts` | the API-only shape; canonical types |
| `approvals.ts` | a permission-gated tool pauses until a human decides |
| `resume.ts` | kill -9: the draft is voided on resume, the run continues |
| `server.ts` | a durable session behind an HTTP endpoint |
| `web.ts` | the trajectory as a shareable HTML artifact |

```sh
npx tsx examples/streaming.ts   # (in a checkout)
```

## 5. What to read next

- `docs/sdk.md` — the curated root manifest, the event stream contract
  (27 frozen variants), and what lives behind `./internal`.
- `docs/concepts.md` — durable sessions, persist-first, the projection,
  and why the stream is the state.
