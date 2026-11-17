// Tool rows by name (owner 2026-11-17): every tool the web can run has a display name and an object; a tool with no object shows none (never "."),
// an MCP tool reads "server · tool", and a call a restart cut off is "Interrupted" in grey, never red. Hand-made logs.
import { copyFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, checker, launchApp, waitUntil, sleep } from "./lib.mjs";

const { check, verdict } = checker("tool-names"); const data = scratch("tn-data");
const app = await launchApp({ data, workspace: scratch("tn-ws"), env: { KISO_WEB_SESSION: "w-seed", KISO_WEB_MODE: "full-access" }, fauxScript: [{ events: [{ type: "text_delta", text: "seed" }, { type: "stop", reason: "end_turn" }] }] });
await app.evaluate(`window.__kiso.send("seed")`); await waitUntil(async () => (await app.count("[data-kind=footer]")) === 1, 20_000);
const dir = join(data, "projects", readdirSync(join(data, "projects"))[0]); const asks = { questions: [{ question: "Which year range should the import cover?", options: [{ label: "2024 only" }] }] };
const done = (out) => [{ type: "tool_execution_succeeded", executionId: "ex-1", callId: "c1", invocationSeq: 1, result: { content: out, isError: false } }, { type: "tool_result", callId: "c1", invocationSeq: 1, content: out, isError: false, executionId: "ex-1" }];
const cut = [{ type: "tool_execution_resolved", executionId: "ex-1", callId: "c1", resolution: "rerun" }, { type: "tool_result", callId: "c1", invocationSeq: 1, content: "[Permission denied] interrupted execution", isError: true, errorKind: "precondition", executionId: "ex-1" }];
for (const [file, name, input, tail] of [["ask_user", "ask_user", asks, done("answered")], ["list_sessions", "list_sessions", { query: "payment" }, done("x")], ["read_skill", "read_skill", { name: "release-notes" }, done("x")], ["mcp", "mcp__github__create_issue", { title: "x" }, done("x")], ["interrupted", "ask_user", asks, cut]]) {
	const ev = [{ type: "user_input", content: file }, { type: "tool_call_end", callId: "c1", name, input }, { type: "permission_decided", decisionId: "d1", callId: "c1", invocationSeq: 1, decision: "approved", decidedBy: "mode:full-access" }, { type: "stop", reason: "tool_use" }, { type: "tool_execution_started", callId: "c1", invocationSeq: 1, name, input, executionId: "ex-1" }, ...tail, { type: "text_delta", text: "Done." }, { type: "stop", reason: "end_turn" }, { type: "terminal", outcome: { kind: "completed" } }];
	writeFileSync(join(dir, `${file}.jsonl`), ev.map((event, seq) => JSON.stringify({ runId: "r", ts: Date.now() + seq, event: { ...event, seq } })).join("\n") + "\n"); copyFileSync(join(dir, "w-seed.meta.json"), join(dir, `${file}.meta.json`));
}
await app.restart(); await app.evaluate("location.reload()"); await waitUntil(async () => (await app.count(".item")) >= 6, 20_000);
const row = async (title) => {
	await app.evaluate(`[...document.querySelectorAll(".item")].find((e) => e.textContent.startsWith(${JSON.stringify(title)}))?.click()`);
	await waitUntil(async () => (await app.count("[data-kind=process]")) > 0, 10_000); await app.evaluate("document.querySelector('[data-kind=process] .ph')?.click()"); await sleep(500);
	return JSON.parse(await app.evaluate("JSON.stringify([...document.querySelectorAll('[data-kind=step]')].map((s) => [s.className, s.querySelector('.s-verb').textContent, s.querySelector('.s-obj')?.textContent ?? '', s.querySelector('.s-time').textContent, document.querySelector('.ph .lab').textContent]))")).at(0);
};
const [a, l, r, m, i] = [await row("ask_user"), await row("list_sessions"), await row("read_skill"), await row("mcp"), await row("interrupted")];
check(a[1] === "Ask" && a[2] === "Which year range should the import cover?" && a[4] === "Asked a question", `ask_user: a name, its first question, a summary (${a})`);
check(l[1] === "List sessions" && l[2] === "payment" && r[1] === "Read skill" && r[2] === "release-notes" && m[1] === "github · create_issue" && m[2] === "" && !m[4].includes("mcp__"), `list_sessions shows its query, read_skill its skill, an MCP tool reads "server · tool" with no "." (${[l, r, m]})`);
check(i[0].includes("interrupted") && !i[0].includes("failed") && i[3] === "Interrupted" && !i[4].includes("failed"), `a call a restart cut off is Interrupted, not failed (${i})`);
await app.close(); verdict();
