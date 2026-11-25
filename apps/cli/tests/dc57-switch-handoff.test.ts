/**
 * DC-57 — the line that arrives WITH a switch command goes to the session
 * that was asked for (the owner's ruling, 2026-09-21: option ① queue it).
 *
 * A switch is not applied at the moment it is requested: `/resume <id>` sets
 * a pending target and `chat()` returns; the loop opens the new session
 * afterwards. One read can carry several lines — a paste, a pipe, a
 * scripted driver — and the DEPARTING instance used to dispatch the rest of
 * the batch, so the turn landed in the session the person was leaving (and
 * spent that session's context: the measured probe was a prompt answered by
 * `fresh` while the switch to `alpha` happened afterwards).
 *
 * The fix is the mechanism the pre-ready lines already use: once the session
 * is leaving, further lines are queued and replayed by the NEXT `chat()`
 * entry. This gate asserts it on the durable logs — which session's
 * `user_input` the line became — never on the screen.
 *
 * THE BOUNDARY, pinned here so it is a decision rather than an accident, and
 * it has TWO refusals with two different answers:
 *   - the target does NOT list (a typo, or a sidecar that cannot be read and
 *     so is never offered) — the person never left, and the rest of the batch
 *     is theirs in the session they are in;
 *   - the target EXISTS and cannot be OPENED (an XP-era log with scoped
 *     continuation envelopes and no sidecar: the fail-closed integrity case) —
 *     here the line must NOT be answered by the session being left. It is held
 *     back and printed, so nothing vanishes in silence.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "@vincemakes/kiso-runtime";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

function fauxScript(): string {
	const f = join(mkdtempSync(join(tmpdir(), "kiso-dc57-faux-")), "faux.json");
	writeFileSync(f, JSON.stringify(Array.from({ length: 12 }, () => ({ events: [{ type: "text_delta", text: "ok" }, { type: "stop", reason: "end_turn" }] }))));
	return f;
}

/** Every `user_input` string in a session's durable log. */
function said(home: string, id: string): string[] {
	const log = join(home, "sessions", `${id}.jsonl`);
	const out: string[] = [];
	// A session nothing was ever said in has NO log — the switch left it empty —
	// so absence is the honest answer here, not an error.
	if (!existsSync(log)) return out;
	for (const line of readFileSync(log, "utf8").split("\n")) {
		if (!line.includes("user_input")) continue;
		try {
			const e = JSON.parse(line) as { event?: { type?: string; content?: string; text?: string } };
			if (e.event?.type !== "user_input") continue;
			out.push(String(e.event.content ?? e.event.text ?? ""));
		} catch {
			/* not this line */
		}
	}
	return out;
}

describe("DC-57 — a line that arrives with a switch belongs to the new session", () => {
	it("`/resume alpha` + a prompt in ONE read: the prompt is ALPHA's turn, not the departing session's", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript() });
		expect(runCli(["-p", "hi", "alpha"], env, { timeout: 60_000 }).status).toBe(0);
		expect(runCli(["-p", "hi", "beta"], env, { timeout: 60_000 }).status).toBe(0);

		const run = runCli(["chat", "fresh"], env, { input: "/resume alpha\ntell me about widgets\n", timeout: 90_000 });
		const out = stripANSI(`${run.stdout}${run.stderr}`);
		expect(run.status, out).toBe(0);
		expect(out, "the switch itself still happens").toContain("session alpha (switched");
		expect(said(dirs.home, "alpha"), "the prompt is the NEW session's turn").toContain("tell me about widgets");
		expect(said(dirs.home, "fresh"), "and NEVER the departing session's").not.toContain("tell me about widgets");
	});

	it("a target that does not LIST: the refusal is stated, and the batch stays with the person where they are", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript() });
		expect(runCli(["-p", "hi", "alpha"], env, { timeout: 60_000 }).status).toBe(0);
		// a sidecar that does not parse: the session is never offered, and it is
		// never read as absent either (the fail-closed integrity rule)
		writeFileSync(join(dirs.home, "sessions", "broken.meta.json"), "{ this is not json");

		const run = runCli(["chat", "fresh"], env, { input: "/resume broken\nthis line is for the person\n", timeout: 90_000 });
		const out = stripANSI(`${run.stdout}${run.stderr}`);
		expect(run.status, "the REPL survives a refused in-session switch").toBe(0);
		expect(out, "the refusal says which id was not found").toContain("no such session: broken");
		expect(
			said(dirs.home, "fresh"),
			"the person never left, so the line is answered where they are — NOT ①'s case (see the header)",
		).toContain("this line is for the person");
		expect(said(dirs.home, "broken"), "and nothing was written into the session that could not be opened").toEqual([]);
	});

	it("a target that EXISTS and cannot be OPENED: its lines are held back, never answered by the old session", async () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript() });
		expect(runCli(["-p", "hi", "alpha"], env, { timeout: 60_000 }).status).toBe(0);
		// the XP-era shape: a log whose envelopes carry a scope and NO sidecar —
		// the fail-closed case that BLOCKS the open (and still lists, because the
		// log is there)
		const store = new SessionStore(join(dirs.home, "sessions"));
		await store.append("legacy", "r1", { seq: 0, type: "user_input", content: "go" } as never);
		await store.append("legacy", "r1", {
			seq: 1,
			type: "stop",
			reason: "end_turn",
			continuation: { scope: { providerId: "anthropic", apiId: "anthropic-messages", modelId: "m" }, entries: [] },
		} as never);
		await store.closeAll();

		const run = runCli(["chat", "fresh"], env, { input: "/resume legacy\nthis belongs to legacy\n", timeout: 90_000 });
		const out = stripANSI(`${run.stdout}${run.stderr}`);
		expect(run.status, "the REPL survives the refusal").toBe(0);
		expect(out, "the integrity refusal is stated").toMatch(/integrity|missing/i);
		expect(out, "and the held line is named, so nothing vanishes in silence").toContain("this belongs to legacy");
		expect(out, "with the ruling's own wording").toMatch(/held back/);
		expect(said(dirs.home, "fresh"), "the session we stayed in did NOT answer it").not.toContain("this belongs to legacy");
	});

	it("a switch with nothing after it behaves exactly as before (the control)", () => {
		const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript() });
		expect(runCli(["-p", "hi", "alpha"], env, { timeout: 60_000 }).status).toBe(0);
		const run = runCli(["chat", "fresh"], env, { input: "/resume alpha\n", timeout: 90_000 });
		const out = stripANSI(`${run.stdout}${run.stderr}`);
		expect(run.status, out).toBe(0);
		expect(out).toContain("session alpha (switched");
		expect(said(dirs.home, "alpha"), "no phantom turn was invented").toEqual(["hi"]);
	});
});
