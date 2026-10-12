# @vincemakes/kiso-tools-node

Coding tools for Node hosts, bound to an explicit workspace root:
read_file, list_dir, search_text (idempotent reads), write_file,
edit_file (safe replacement — external hard links are never
overwritten), and shell (process-tree kill on timeout/abort).

Background tasks (ADR-0058): pass `tasks: (sessionId) => …` — the
runtime's per-session `TaskManager`, with `processTaskBackend()` — and the
shell promotes a command that outlives `foregroundMs` to a task instead of
killing it, starts one at once with `background: true`, ends its wait on
`readyWhen`; `task_stop` joins the tools and `read_file` serves the
session's task outputs. `inspect_result` joins them too: a bounded
(12 KiB), streaming query — info, range, grep, tail — over a task's
output or a subagent's answer and rendered tool calls, by a ref
(`result:task:<id>`, `result:subagent:<childId>[/work]`) that resolves
only within the calling session's store. Without `tasks`, the shell is
unchanged and neither tool exists.

See the repository README for the framework overview.
