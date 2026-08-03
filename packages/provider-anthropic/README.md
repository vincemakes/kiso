# @kiso/provider-anthropic

The Anthropic adapter on the official SDK: wire events mapped to the
kiso event union, cancellation via the run signal, exhaustive stop-reason
mapping (refusal/pause_turn/context-window are never completed), real
usage and cache counters.

Requires Node >= 22. See the repository README for the framework
overview.
