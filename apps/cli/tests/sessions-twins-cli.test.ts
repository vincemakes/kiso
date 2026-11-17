/**
 * ADR-0062 § 14 test 14: a Work the web created with the sessions tools, resumed in the terminal. The three tools are in its
 * table and each refuses with the reason; and nothing they would have made exists afterwards: no inbox for any session, no
 * card, no new session, no parent link. Through the front door (`kiso -p … <id>`), the model scripted.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasSessionsTools, markSessionsTools, readCards, readStartedBy, SESSIONS_REFUSAL } from "@vincemakes/kiso-runtime/internal";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const call = (callId: string, name: string, input: unknown) => ({ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] });
const script = (steps: unknown[]): string => {
	const f = join(mkdtempSync(join(tmpdir(), "kiso-twins-faux-")), "faux.json");
	writeFileSync(f, JSON.stringify(steps));
	return f;
};

describe("test 14: a web-created Work in the terminal", () => {
	it("the three tools refuse; no inbox file, no card, no session, no parent link is left", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script([say("ok")]) });
		const sessions = join(dirs.home, "sessions");
		expect(runCli(["-p", "hi", "other"], env, { timeout: 60_000 }).status).toBe(0);
		expect(runCli(["-p", "hi", "web"], env, { timeout: 60_000 }).status).toBe(0);
		markSessionsTools(sessions, "web"); // as kiso web marks a Work it created with the extension on
		const before = readdirSync(sessions).sort();

		const steps = [
			say("Parser and schema"), // a side request before the run (the terminal's own, not the Work's turn) takes the first reply
			call("c1", "list_sessions", {}),
			call("c2", "message", { to: "other", text: "The schema is in docs/schema.md." }),
			call("c3", "start_session", { title: "Parser", brief: "Build the parser.", initiation: "asked", context: "fresh" }),
			say("Told the person."),
		];
		const run = runCli(["-p", "Tell other about the schema and start a parser Work.", "web"], { ...env, KISO_FAUX_SCRIPT: script(steps) }, { timeout: 60_000 });
		expect(run.status, `${run.stdout}${run.stderr}`).toBe(0);

		const log = readFileSync(join(sessions, "web.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event);
		const results = log.filter((e) => e.type === "tool_result" && ["c1", "c2", "c3"].includes(e.callId));
		expect(results.map((e) => [e.callId, e.isError, e.content]), "each refuses with the reason").toEqual([
			["c1", true, SESSIONS_REFUSAL],
			["c2", true, SESSIONS_REFUSAL],
			["c3", true, SESSIONS_REFUSAL],
		]);
		expect(hasSessionsTools(sessions, "web"), "the Work keeps its table").toBe(true);
		const after = readdirSync(sessions).sort();
		expect(after.filter((n) => n.endsWith(".inbox")), "no inbox for any session").toEqual([]);
		expect(after.filter((n) => n.endsWith(".jsonl")), "no new session").toEqual(before.filter((n) => n.endsWith(".jsonl")));
		expect(readCards(sessions, "web"), "no card").toEqual({});
		expect(readStartedBy(sessions, "other"), "no parent link").toBeNull();
		expect(existsSync(join(dirs.home, "chains")), "no wake spent").toBe(false);
	}, 120_000);
});
