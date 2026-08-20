/**
 * kiso (foundation) official task extension — ⑥: long-horizon working memory,
 * kernel untouched.
 *
 * task_set is a WHOLE-TABLE REPLACE (the CC whole-table-replace shape): the model
 * sends the complete current list on every update — one item marked
 * active/done, the rest carried over verbatim. Idempotent: the same items
 * in → the same echo out, byte for byte.
 *
 * The extension is STATELESS — the list's memory is the SESSION EVENT LOG.
 * The result (the normalized echo) is a durable tool-result message: it
 * survives kill -9 (a resume rebuilds the projection from the log) and
 * /compact (the result is tagged do-not-compact, so the summary layer's
 * boundary never covers its round — the contrast with Claude Code's
 * runtime-state checklist, which dies with the process).
 *
 * The content contract (the CLI's checklist cell parses this EXACT shape
 * — keep it stable):
 *   [task] 3 items — 1 pending, 1 active, 1 done
 *   [pending] write the plan
 *   [active] implement the feature
 *   [done] verify with tests
 * The first line is a count summary; every item line is
 * `[<status>] <text>`. Unknown lines never appear — the echo is the
 * canonical form.
 */

const MAX_ITEMS = 50;
const MAX_TEXT = 500;
const STATUSES = ["pending", "active", "done"];

/** Parse + validate ONE call. Pure: same input, same echo. */
export function parseTaskSet(input) {
  const raw = (input ?? {}).items;
  if (!Array.isArray(raw)) {
    return { error: "task_set: 'items' must be an array of {text, status}" };
  }
  if (raw.length > MAX_ITEMS) {
    return { error: `task_set: at most ${MAX_ITEMS} items (got ${raw.length})` };
  }
  const items = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) {
      return { error: `task_set: item ${i} is not an object` };
    }
    const status = item.status;
    if (!STATUSES.includes(status)) {
      return { error: `task_set: item ${i} status must be one of ${STATUSES.join("/")} (got "${String(status)}")` };
    }
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (text === "") {
      return { error: `task_set: item ${i} text must be a non-empty string` };
    }
    if (text.length > MAX_TEXT) {
      return { error: `task_set: item ${i} text exceeds ${MAX_TEXT} chars (got ${text.length})` };
    }
    items.push({ text, status });
  }
  // CC's discipline: at most ONE active item — a second active means the
  // model did not mark the previous step done. Refused loudly, never
  // silently normalized.
  const active = items.filter((it) => it.status === "active");
  if (active.length > 1) {
    return { error: `task_set: at most one active item (${active.length} are active — mark the others done first)` };
  }
  return { items };
}

/** The normalized echo — the deterministic, parseable canonical form. */
export function taskEcho(items) {
  const counts = { pending: 0, active: 0, done: 0 };
  for (const it of items) counts[it.status] += 1;
  const lines = [
    `[task] ${items.length} item${items.length === 1 ? "" : "s"} — ${counts.pending} pending, ${counts.active} active, ${counts.done} done`,
    ...items.map((it) => `[${it.status}] ${it.text}`),
  ];
  return lines.join("\n");
}

export default function createTaskExtension() {
  return {
    name: "task",
    // TT-1A ③ — the extension speaks for its OWN tool, and only its own:
    // allow task_set, abstain on everything else. Proof A (authorization):
    // task_set cannot change the external world — it parses and echoes a
    // canonical list into the session's own log; auto-allowing it is
    // sound, and the 0.14.0 dogfood showed the alternative (an
    // all-abstain chain asks on EVERY update — the abstain verdict doing
    // its job on a tool nobody had spoken for). The chain is
    // deny > allow > ask (W21/R3), so this allow can never un-deny
    // another speaker's deny.
    approvals: [
      {
        decide: (call) =>
          call.name === "task_set"
            ? { action: "allow", reason: "recording the plan in the session's own log changes nothing outside it" }
            : { action: "abstain" },
      },
    ],
    tools: [
      {
        name: "task_set",
        description:
          "set the work plan as a whole-table replace: pass the COMPLETE current list (each item {text, status}) — at most one active. The result echoes the normalized list; it survives /compact and kill -9 (durable working memory).",
        // TT-1A ① — a pure parse→echo may honestly declare idempotency:
        // the same items in, the same echo out, byte for byte; without
        // this the kernel's "side effects may have partially applied"
        // note rides every invalid_input refusal — a false statement
        // about a tool with no effects (the ask_user precedent).
        idempotent: true,
        // TT-1A ② — Proof B (scheduling): read-only of the world + free +
        // local + no shared mutable state in the handler ⇒ every
        // invocation may overlap every sibling; a TODO update stops
        // blocking the FIFO queue. precommitSafe is deliberately ABSENT
        // (the adjudicated rejection): the CLAIM must wait for Turn
        // Commit — admissibility is a turn-validity property, not a tool
        // property; speculative stays parked until a measured bottleneck.
        effects: { concurrency: "shared" },
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
                  status: { type: "string", enum: STATUSES },
                },
                required: ["text", "status"],
              },
              maxItems: MAX_ITEMS,
            },
          },
          required: ["items"],
        },
        execute: async (input) => {
          const parsed = parseTaskSet(input);
          if (parsed.error !== undefined) {
            return { content: parsed.error, isError: true, errorKind: "invalid_input" };
          }
          return { content: taskEcho(parsed.items), isError: false, tags: ["do-not-compact"] };
        },
      },
    ],
    // The plan guidance — restrained, no runtime checks (a verification
    // step is a discipline, not a gate).
    systemPrompt: {
      append: [
        "Work planning (task_set):",
        "- For a task with 3+ steps, call task_set once up front with one item",
        "  per step, and make the LAST item a verification step.",
        "- Mark an item active just before you start it — at most one active.",
        "- Mark an item done the moment its step completes, then call",
        "  task_set again with the whole updated list.",
        "- For a single small step, skip the list and do the work directly.",
      ].join("\n"),
    },
  };
}
