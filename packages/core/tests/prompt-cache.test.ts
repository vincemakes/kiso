/**
 * D area — the prompt-cache byte discipline.
 *
 * Contract: the SAME event-stream prefix must project to a BYTE-IDENTICAL
 * message prefix (JSON.stringify, element for element). New events only
 * ever change the projection at the TAIL; the sole exception is the
 * `microcompacted` boundary — an explicit persisted fact whose replay
 * derives the same projection every time.
 */

import { describe, expect, it } from "vitest";
import { EventLog, projectMessages } from "../src/index.js";

describe("D: byte-identical projection discipline", () => {
	it("① the same log projects identically twice — byte for byte", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.ts" } });
		log.append({ type: "tool_result", callId: "c1", content: "line1\nline2\n", isError: false });
		log.append({ type: "stop", reason: "end_turn" });
		const a = projectMessages(log.all);
		const b = projectMessages(log.all);
		expect(JSON.stringify(a)).toBe(JSON.stringify(b));
		expect(a).toHaveLength(b.length);
	});

	it("①b (A5 rule-1 obligation iii): a continuation-bearing stop keeps the discipline — deterministic, and the OLD PREFIX untouched", () => {
		const cont = {
			scope: { providerId: "anthropic", apiId: "anthropic-messages", modelId: "claude-x" },
			entries: [{ kind: "anthropic.content_block", required: true, data: JSON.stringify({ type: "thinking", thinking: "t", signature: "s" }) }],
		};
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "text_delta", text: "first" });
		log.append({ type: "stop", reason: "end_turn" });
		const before = JSON.stringify(projectMessages(log.all));
		log.append({ type: "user_input", content: "more" });
		log.append({ type: "text_delta", text: "second" });
		log.append({ type: "stop", reason: "end_turn", continuation: cont } as never);
		const a1 = projectMessages(log.all);
		const b1 = projectMessages(log.all);
		expect(JSON.stringify(a1), "deterministic with the envelope").toBe(JSON.stringify(b1));
		expect(JSON.stringify(a1.slice(0, 2)), "the pre-envelope PREFIX is byte-identical").toBe(before);
		expect((a1[3] as { continuation?: unknown }).continuation, "the envelope rides ITS message only").toEqual(cont);
		expect((a1[1] as { continuation?: unknown }).continuation).toBeUndefined();
	});

	it("② appending one more turn leaves the OLD PREFIX byte-identical", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "shell", input: { command: "npm test" } });
		log.append({ type: "tool_result", callId: "c1", content: "pass\n", isError: false });
		log.append({ type: "stop", reason: "end_turn" });
		log.append({ type: "terminal", outcome: { kind: "completed" } });
		const before = projectMessages(log.all);

		// A second user turn appends to the stream.
		log.append({ type: "user_input", content: "more" });
		log.append({ type: "tool_call_end", callId: "c2", name: "list_dir", input: {} });
		log.append({ type: "tool_result", callId: "c2", content: "dir a/\n", isError: false });
		log.append({ type: "stop", reason: "end_turn" });
		log.append({ type: "terminal", outcome: { kind: "completed" } });
		const after = projectMessages(log.all);

		// The prefix is unchanged, element for element, byte for byte.
		expect(after.length).toBeGreaterThan(before.length);
		const prefix = after.slice(0, before.length);
		expect(JSON.stringify(prefix)).toBe(JSON.stringify(before));
	});

	it("③ after a microcompact boundary, a reloaded (JSON round-trip) log projects byte-identically to memory", () => {
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		for (let i = 0; i < 8; i++) {
			log.append({ type: "tool_call_end", callId: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } });
			log.append({ type: "tool_result", callId: `r${i}`, content: "line\n".repeat(50), isError: false });
			log.append({ type: "user_input", content: `t${i}` });
		}
		log.append({ type: "microcompacted", beforeSeq: 3 });
		const inMemory = projectMessages(log.all);
		// A crash + resume replays the SAME events from disk.
		const reloaded = projectMessages(JSON.parse(JSON.stringify(log.all)) as Parameters<typeof projectMessages>[0]);
		expect(JSON.stringify(reloaded)).toBe(JSON.stringify(inMemory));
	});

	it("④ a compacted-era log (v1 {callId, content}) projects to the same bytes every time — R1a/R8a", () => {
		// R-H 0.1.49 (ADR-0051): the compacted upgrade mapping must not
		// change the provider projection bytes — the replay replaces the
		// cleared result with the compacted marker, byte for byte, on
		// every recomputation. (The v1 READING rules are pinned by
		// legacy-session-upgrade.test.ts; this case pins the BYTES.)
		const log = new EventLog();
		log.append({ type: "user_input", content: "go" });
		log.append({ type: "tool_call_end", callId: "c1", name: "web_search", input: { query: "k" } });
		log.append({ type: "tool_result", callId: "c1", content: "original long result", isError: false });
		log.append({ type: "compacted", cleared: [{ callId: "c1", content: "[content cleared — reference by revision] old marker" }] });
		log.append({ type: "stop", reason: "end_turn" });
		log.append({ type: "terminal", outcome: { kind: "completed" } });
		const a = projectMessages(log.all);
		// The replay replacement is the stable byte shape.
		const tool = a.find((m) => m.role === "tool");
		expect(tool?.content).toBe("[content cleared — reference by revision] old marker");
		// Reload round-trip + recomputation: byte-identical every time.
		const reloaded = projectMessages(JSON.parse(JSON.stringify(log.all)) as Parameters<typeof projectMessages>[0]);
		expect(JSON.stringify(reloaded)).toBe(JSON.stringify(a));
		expect(JSON.stringify(projectMessages(log.all))).toBe(JSON.stringify(a));
	});
	it("⑤ TRACE-F1: a usage carrying `servedModel` projects to the SAME bytes as one without it", () => {
		// ADR-0051 §5.1, rule R6 — optional-field admission requires a case
		// HERE, not a declaration elsewhere: "a new optional field MUST add a
		// corresponding fixture case to the existing prompt-cache
		// byte-discipline gate". The three admission conditions are what this
		// pins: (i) old logs project byte-identically, (iii) the field never
		// changes the meaning of existing bytes. (ii), the validator's true
		// optionality, is pinned by event-schema's `TRACE-F1: servedModel is
		// optional` case — which did NOT exist when this comment first
		// claimed it did (Astra caught the claim). A comment asserting a
		// gate is not a gate.
		//
		// The field is the SERVER's statement about which model answered. It
		// is recorded so a silently aliased id stops being invisible — it is
		// not context, and a byte of it must never reach a provider request,
		// or recording the observation would itself invalidate the cache the
		// observation exists to measure.
		const build = (withField: boolean): ReturnType<typeof projectMessages> => {
			const log = new EventLog();
			log.append({ type: "user_input", content: "go" });
			log.append({ type: "tool_call_end", callId: "c1", name: "read_file", input: { path: "a.ts" } });
			log.append({ type: "tool_result", callId: "c1", content: "line1\n", isError: false });
			log.append(
				withField
					? { type: "usage", inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: null, known: true, servedModel: "served-elsewhere" }
					: { type: "usage", inputTokens: 10, outputTokens: 2, cacheRead: 0, cacheWrite: null, known: true },
			);
			log.append({ type: "stop", reason: "end_turn" });
			return projectMessages(log.all);
		};
		const withField = build(true);
		const without = build(false);
		expect(JSON.stringify(withField), "the served id leaked into the projection — it is an observation, not context").toBe(
			JSON.stringify(without),
		);
		// and the id itself appears nowhere in the bytes a provider would see
		expect(JSON.stringify(withField)).not.toContain("served-elsewhere");
	});
	it("⑦ ADR-0051 Amendment 8: a task notice's `via` projects to the SAME bytes as the notice without it", () => {
		// the receipt lives in the log; not one byte of it may reach a request
		const build = (withField: boolean) => {
			const log = new EventLog();
			log.append({ type: "user_input", content: "start the server", source: "user" });
			const notice = '<kiso-task id="t1" status="exited" code="0"/>\nRuntime notice — not the user.';
			const via = { kind: "tasks" as const, items: [{ taskId: "t1", transition: "exited" as const }] };
			log.append(withField ? { type: "user_input", content: notice, source: "system", via } : { type: "user_input", content: notice, source: "system" });
			return projectMessages(log.all);
		};
		expect(JSON.stringify(build(true)), "a tasks via leaked into the projection").toBe(JSON.stringify(build(false)));
	});

	it("⑥ 0.40.0: a user_input carrying `via` projects to the SAME bytes as one without it", () => {
		// ADR-0051 §5 rule 1, R6 — the byte-discipline fixture for the
		// optional field. `via` records HOW a person's turn was composed (a
		// skill, and the line they typed); the model already receives the
		// composed text as `content`. A byte of `via` in a request would be
		// the typed line sent twice — and a request that differs from the
		// replayed one after a resume.
		const build = (withField: boolean): ReturnType<typeof projectMessages> => {
			const log = new EventLog();
			const via = { kind: "skill" as const, name: "review", line: "/review src/a.ts" };
			log.append(withField ? { type: "user_input", content: "Review the file.\n\nsrc/a.ts", source: "user", via } : { type: "user_input", content: "Review the file.\n\nsrc/a.ts", source: "user" });
			log.append({ type: "text_delta", text: "ok" });
			log.append({ type: "stop", reason: "end_turn" });
			log.append({ type: "user_input", content: "next" });
			// a reload (JSON round-trip) is what a resume projects from
			return projectMessages(JSON.parse(JSON.stringify(log.all)) as Parameters<typeof projectMessages>[0]);
		};
		const withField = build(true);
		expect(JSON.stringify(withField), "via leaked into the projection — it is display provenance, not context").toBe(JSON.stringify(build(false)));
		expect(JSON.stringify(withField)).not.toContain("/review");
	});
});
