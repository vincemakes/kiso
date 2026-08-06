/**
 * ⑥ — the todo extension unit tests: the whole-table replace is
 * IDEMPOTENT (same input → same echo, byte for byte), the single-active
 * discipline refuses a second active loudly, the status enum is closed,
 * the echo is the deterministic canonical form (the CLI's checklist cell
 * parses it), the result carries the do-not-compact tag, and the tool is
 * NOT in the microcompact whitelist (it is never cleared mechanically —
 * the tag is the /compact-side contract).
 */

import { describe, expect, it } from "vitest";
import { MICROCOMPACTABLE } from "@vincemakes/kiso-core";
import createTodoExtension, { parseTodoSet, todoEcho } from "../src/kiso-todo.mjs";
import type { Tool } from "@vincemakes/kiso-core";

const ctx = { signal: new AbortController().signal };

const todoTool = (): Tool => {
  const t = createTodoExtension().tools?.find((x) => x.name === "todo_set");
  if (t === undefined) throw new Error("no todo_set tool");
  return t;
};

describe("⑥ todo: the whole-table replace", () => {
  it("idempotent: the same items in → the same echo out, byte for byte", async () => {
    const items = [
      { text: "write the plan", status: "done" },
      { text: "implement", status: "active" },
      { text: "verify with tests", status: "pending" },
    ];
    const first = await todoTool().execute({ items }, ctx);
    const second = await todoTool().execute({ items }, ctx);
    expect(first).toEqual(second);
    expect(second.isError).toBe(false);
  });

  it("the echo is the canonical deterministic form (the CLI parses this)", async () => {
    const items = [
      { text: "write the plan", status: "done" },
      { text: "implement", status: "active" },
      { text: "verify with tests", status: "pending" },
    ];
    const result = await todoTool().execute({ items }, ctx);
    expect(result.content).toBe(
      "[todo] 3 items — 1 pending, 1 active, 1 done\n" +
        "[done] write the plan\n" +
        "[active] implement\n" +
        "[pending] verify with tests",
    );
  });

  it("whole-table replace: a later call with fewer items REPLACES, never merges", async () => {
    // The tool is stateless — the replace semantics are the model's, the
    // echo carries only what this call passed.
    const items = [{ text: "only this remains", status: "pending" }];
    const result = await todoTool().execute({ items }, ctx);
    expect(result.content).toBe("[todo] 1 item — 1 pending, 0 active, 0 done\n[pending] only this remains");
  });

  it("empty list clears the table (0 items, honest echo)", async () => {
    const result = await todoTool().execute({ items: [] }, ctx);
    expect(result.content).toBe("[todo] 0 items — 0 pending, 0 active, 0 done");
    expect(result.isError).toBe(false);
  });
});

describe("⑥ todo: validation (loud invalid_input, never silent normalization)", () => {
  it("refuses TWO active items with the CC discipline", async () => {
    const result = await todoTool().execute(
      { items: [{ text: "a", status: "active" }, { text: "b", status: "active" }] },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("invalid_input");
    expect(String(result.content)).toContain("at most one active");
  });

  it("one active is fine; zero active is fine", async () => {
    const one = await todoTool().execute({ items: [{ text: "a", status: "active" }] }, ctx);
    const zero = await todoTool().execute({ items: [{ text: "a", status: "pending" }] }, ctx);
    expect(one.isError).toBe(false);
    expect(zero.isError).toBe(false);
  });

  it("the status enum is closed — anything else is invalid_input", async () => {
    const result = await todoTool().execute({ items: [{ text: "a", status: "blocked" }] }, ctx);
    expect(result.isError).toBe(true);
    expect(result.errorKind).toBe("invalid_input");
    expect(String(result.content)).toContain("pending/active/done");
  });

  it("empty text after trim is invalid_input; text is trimmed in the echo", async () => {
    const empty = await todoTool().execute({ items: [{ text: "   ", status: "pending" }] }, ctx);
    expect(empty.isError).toBe(true);
    const trimmed = await todoTool().execute({ items: [{ text: "  plan  ", status: "pending" }] }, ctx);
    expect(String(trimmed.content)).toContain("[pending] plan");
  });

  it("caps: >50 items and >500-char texts are refused with the reason", async () => {
    const many = await todoTool().execute({ items: Array.from({ length: 51 }, (_, i) => ({ text: `i${i}`, status: "pending" })) }, ctx);
    expect(many.isError).toBe(true);
    expect(String(many.content)).toContain("at most 50 items");
    const long = await todoTool().execute({ items: [{ text: "x".repeat(501), status: "pending" }] }, ctx);
    expect(long.isError).toBe(true);
    expect(String(long.content)).toContain("500 chars");
  });

  it("non-array items and non-object entries are invalid_input", async () => {
    const noArray = await todoTool().execute({}, ctx);
    expect(noArray.isError).toBe(true);
    expect(String(noArray.content)).toContain("'items' must be an array");
    const badEntry = await todoTool().execute({ items: ["not an object"] }, ctx);
    expect(badEntry.isError).toBe(true);
    expect(String(badEntry.content)).toContain("not an object");
  });
});

describe("⑥ todo: the durable-memory contract", () => {
  it("the result carries tags:['do-not-compact']", async () => {
    const result = await todoTool().execute({ items: [{ text: "a", status: "pending" }] }, ctx);
    expect(result.tags).toEqual(["do-not-compact"]);
  });

  it("todo_set is NOT in the microcompact whitelist — never cleared mechanically", () => {
    expect(MICROCOMPACTABLE.has("todo_set")).toBe(false);
  });

  it("the systemPrompt append carries the plan discipline, restrained", () => {
    const append = createTodoExtension().systemPrompt?.append ?? "";
    expect(append).toContain("todo_set");
    expect(append).toContain("verification step");
    expect(append.split("\n").length).toBeLessThanOrEqual(15);
  });

  it("parseTodoSet is a pure function: same input, same output", () => {
    const input = { items: [{ text: " a ", status: "active" }] };
    expect(parseTodoSet(input)).toEqual(parseTodoSet(JSON.parse(JSON.stringify(input))));
    expect(todoEcho([{ text: "a", status: "pending" }])).toBe(todoEcho([{ text: "a", status: "pending" }]));
  });
});
