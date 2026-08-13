// E4-b — the OFF-arm task shell: a name-only extension that SHADOWS the
// built-in task extension through the builtInLayer rule (a user extension
// with the same name replaces the built-in, loudly — the user's
// deliberate install wins). No tools, no systemPrompt.append: the OFF
// arm pays exactly E3's measured delta less per request (the task_set
// spec 551 chars + the plan-guidance append 394 chars), and the rent
// ledger proves it — no system:ext:task, no tool:task_set in any OFF
// record (the extractor's arm detector, extract-planning.py).
export default { name: "task" };
