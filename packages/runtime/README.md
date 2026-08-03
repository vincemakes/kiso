# @kiso/runtime

The durable session layer: createAgent, AgentSession, Run, the
crash-safe append-only JSONL store (torn-tail repair, cross-process
writer locks, expected-last-seq CAS), per-run recovery (session.resume),
real approval pauses, and the uncertain-execution ledger.

See the repository README for the framework overview.
