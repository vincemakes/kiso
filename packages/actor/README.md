# @vincemakes/kiso-actor

Durable work over disposable sessions (ADR-0064). Work state is a strict reducer
over an append-only work log; sessions are execution context for a work.

Private: not published until the C0 consumer integration. Import it only through
its public index.
