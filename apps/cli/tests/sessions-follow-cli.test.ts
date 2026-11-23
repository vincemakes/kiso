/**
 * ADR-0062 § 14 test 14, as Amendment 2 (owner, 2026-11-20) rewrote it: a Work the web made with the sessions tools, resumed in
 * the terminal. The terminal has no such tools, so the Work follows it: the table has none of the three (a call to one is an
 * unknown tool), the mark is cleared once the first event is written (and a revision records the table when it differs). Nothing they would
 * have made exists afterwards: no inbox for any session, no card, no new session, no parent link. Through the front door
 * (`kiso -p … <id>`), the model scripted.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasSessionsTools, markSessionsTools, readCards, readProfile, readStartedBy } from "@vincemakes/kiso-runtime/internal";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";

const say = (text: string) => ({ events: [{ type: "text_delta", text }, { type: "stop", reason: "end_turn" }] });
const call = (callId: string, name: string, input: unknown) => ({ events: [{ type: "tool_call_end", callId, name, input }, { type: "stop", reason: "tool_use" }] });
const script = (steps: unknown[]): string => {
	const f = join(mkdtempSync(join(tmpdir(), "kiso-twins-faux-")), "faux.json");
	writeFileSync(f, JSON.stringify(steps));
	return f;
};

describe("test 14: a web-created Work in the terminal", () => {
	it("the Work follows the terminal: no sessions tools, the mark cleared; no inbox file, no card, no session, no parent link is left", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: script([say("ok")]) });
		const sessions = join(dirs.home, "sessions");
		expect(runCli(["-p", "hi", "other"], env, { timeout: 60_000 }).status).toBe(0);
		expect(runCli(["-p", "hi", "web"], env, { timeout: 60_000 }).status).toBe(0);
		markSessionsTools(sessions, "web"); // as kiso web marks a Work it created with the extension on
		const first = readProfile(sessions, "web");
		const revision = first.kind === "ok" ? first.profile.revision : -1;
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
		expect(results.map((e) => [e.callId, e.isError, /unknown tool/i.test(String(e.content))]), "each is an unknown tool here").toEqual([
			["c1", true, true],
			["c2", true, true],
			["c3", true, true],
		]);
		expect(hasSessionsTools(sessions, "web"), "the Work follows the terminal: unmarked").toBe(false);
		const now = readProfile(sessions, "web");
		// the Work here was made without the tools, so the recorded table is the terminal's own: no revision to add (runtime test: follow-host)
		expect(now.kind === "ok" ? now.profile.revision : -1).toBe(revision);
		const after = readdirSync(sessions).sort();
		expect(after.filter((n) => n.endsWith(".inbox")), "no inbox for any session").toEqual([]);
		expect(after.filter((n) => n.endsWith(".jsonl")), "no new session").toEqual(before.filter((n) => n.endsWith(".jsonl")));
		expect(readCards(sessions, "web"), "no card").toEqual({});
		expect(readStartedBy(sessions, "other"), "no parent link").toBeNull();
		expect(existsSync(join(dirs.home, "chains")), "no wake spent").toBe(false);
	}, 120_000);
});
