# @vincemakes/kiso-provider-openai

The OpenAI-compatible adapter on the official SDK (OpenAI, GLM, Kimi,
DeepSeek, OpenRouter via base_url): reasoning dialects digested into
thinking, real streaming usage, exhaustive finish-reason mapping,
connection/timeout/5xx classification.

Requires Node >= 22. See the repository README for the framework
overview.

## Debug tooling

`KISO_DUMP_REQUESTS=<dir>` writes every outgoing request body to
`<dir>/req-<pid>-<n>.json` before it is sent — the diagnosis instrument
for the request-prefix (D 区) contract, kept as a permanent debug sink.
⚠ The bodies are REAL conversation data (the model may have seen repo
contents) — never share a dump dir; a dump failure never breaks the
request. `bench/dumpdiff.py` byte-diffs consecutive dumps and localizes
the first divergence (healthy = at the older request's last-message end;
violation = inside an old message).
