# @vincemakes/kiso-client

The typed client for a hosted kiso session, over the wire protocol. Run,
resume, abort, approve, the snapshot, and a stream that reconnects with
`Last-Event-ID` and never yields an event twice. Browser and Node: global
`fetch`, no EventSource (it cannot send headers), and nothing from the
runtime — this package depends on `@vincemakes/kiso-protocol` alone.

```ts
import { createClient } from "@vincemakes/kiso-client";

const client = createClient({ baseUrl: "https://api.example.com/v1/sessions", headers: () => ({ authorization: `Bearer ${token}` }) });
const session = client.session("s1");

const { runId } = await session.run("hello");            // ClientError on in_flight / open_run / draining / forbidden
for await (const ev of session.events({ after: -1, until: (e) => e.kind === "event" && e.event.type === "terminal" })) {
  if (ev.kind === "event") render(ev.event);              // a WireEvent under its seq
  else if (ev.event === "billing") bill(ev.data);         // a product frame beside it
}
await session.steer("only the editor tests");             // → { runId }; ClientError idle | closed → run() it instead
const outcome = await session.abort();                    // idle | parked (a reply, not an error) | stopped
await session.approve(decisionId, true);                  // → { needsResume }
```

`events()` keeps the stream alive: a dropped connection reconnects with
the last seq it delivered, with exponential backoff, and the seam is
deduplicated by seq — the transport's replay-from-seq guarantee,
consumed. `runStream()` is one turn on one response (`/run?stream=1`)
with no reconnect; a dropped connection there is the cue to `events()`.

See the repository README for the framework overview.
