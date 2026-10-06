import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import { SessionStore } from "@vincemakes/kiso-runtime";

/**
 * CTX-1, finding F34-1 (Astra, 2026-09-14): ALL THREE entry points that open
 * a session must bind the policy that follows the session's own model.
 *
 * The first fix put those lines in the interactive loop only. `kiso resume
 * <id>` and `kiso -p <text> <id>` open through their own paths: they
 * restored the recorded model and kept the STARTUP threshold. A session
 * recorded on a 1M model, resumed from a 200k start, cleared its tool
 * results at 100,000 through two doors and at 500,000 through the third.
 *
 * THE INVARIANT, re-stated by the owner's ruling of 2026-09-21 (`XP-1`: the
 * CONFIGURATION wins a changed binding, model included): the window and the
 * tiers follow the EFFECTIVE LIVE BINDING — the model that will actually
 * answer. Anything else is the mixed binding the ruling exists to prevent:
 * requests to a 200k model compacted as if it were 1M, where the window is
 * already too small and kiso still believes it is not.
 *
 * So the gate has THREE arms, and their names say which binding is live:
 *   - the CONTROL: the recorded model is one the registry does not know
 *     (200k fallback) — it drifts, and the same history MUST compact;
 *   - the SAME binding (the record left exactly as the process wrote it): no
 *     drift is reported at all, and the window that decides is the process's
 *     own — the same history compacts for the same reason;
 *   - a CHANGED binding (recorded 1M, process 200k): the current
 *     configuration wins, the change is SAID out loud, and the window that
 *     decides is the live one.
 *
 * THE GATE DRIVES THE REAL CLI, three times per arm, on the same state.
 * Testing the setter proves the setter; it was never the setter that was
 * wrong.
 *
 * A CONTROL RUNS TOO, and it is the reason the assertions mean anything.
 * The defect's signature is "no boundary was written", and a boundary can be
 * absent for many uninteresting reasons — the session did not run, the
 * history was too small, the faux adapter never took a turn. So the control
 * flips exactly one field, the recorded model id, to one the registry does
 * not know: at the 200k fallback the same history MUST compact. Absence only
 * counts as evidence when presence is also shown.
 *
 * ADR-0055 Amendment 1 (A1b): the standing microcompact at half the window
 * is gone (A4). What travels with the model now is the WINDOW the in-run
 * tiers are drawn from, and the observable is the tiers' summary: at 200k
 * ~180k is over every tier, so the door fires whatever the phase; at 1M
 * the soft tier is 400k, and the same history stays whole.
 *
 * (The 1M arm cannot run a TURN here: an isolated home has no credentials,
 * and a model that resolves to 1M comes with a provider that would 401. The
 * arms above therefore assert the ruling where it is observable without a
 * network — the drift statement and the boundary count — rather than
 * pretending a faux adapter serves 1M.)
 */

const CLI = join(fileURLToPath(new URL("../..", import.meta.url)), "cli", "dist", "index.js");
const SESSION = "s";
/** KISO_FAUX_SCRIPT names a FILE, not inline JSON.
 *
 *  F34-R1 (Astra): this held EIGHT responses while the seed advances the
 *  script position past FIFTY, so every continuation exhausted the script
 *  and exited 1 with "the scripted demo turns are exhausted". The test
 *  reported 6/6 green anyway, because it counted only boundaries — and the
 *  boundary is written BEFORE the model request, so it survives a run that
 *  then dies. Enough responses to outlast the seed, by a wide margin. */
function fauxScript(): string {
	const f = join(mkdtempSync(join(tmpdir(), "kiso-ctx1-faux-")), "faux.json");
	// Every response is a valid checkpoint, so a summary call gets one and an
	// ordinary turn ends on harmless text (A1b: the tiers' summary is the
	// observable, and it is only written when the checkpoint validates).
	const checkpoint = "## Goal\ng\n## Constraints\nc\n## User requests\nu\n## Files and changes\nf\n## Errors and fixes\nnone\n## Current work\nw\n## Next steps\nn";
	writeFileSync(f, JSON.stringify(Array.from({ length: 200 }, () => ({ events: [{ type: "text_delta", text: checkpoint }, { type: "stop", reason: "end_turn" }] }))));
	return f;
}

/** Terminals whose outcome is `completed`, from the durable log. */
function completedTerminals(home: string): number {
	const log = join(home, "sessions", `${SESSION}.jsonl`);
	let n = 0;
	for (const line of readFileSync(log, "utf8").split("\n")) {
		if (line.trim() === "") continue;
		let rec: { event?: { type?: string; outcome?: { kind?: string } } };
		try { rec = JSON.parse(line) as typeof rec; } catch { continue; }
		const e = rec.event ?? (rec as { type?: string; outcome?: { kind?: string } });
		if (e.type === "terminal" && e.outcome?.kind === "completed") n += 1;
	}
	return n;
}

/** A history whose projected estimate lands between the two windows' tiers:
 *  over the 200k window's hard tier (160k — with no stated max output the
 *  emergency tier folds into hard, ADR-0055 Amendment 2), under the 1M
 *  window's soft (400k).
 *
 *  Written through the STORE, not by appending lines. A hand-written record
 *  is rejected — `line 4 is not a session record` — because the durable
 *  format is more than the event, and a test that writes it by hand is
 *  testing its own guess at the format. */
async function seedHistory(home: string): Promise<void> {
	const store = new SessionStore(join(home, "sessions"));
	const existing = store.load(SESSION).map((r) => r.event);
	let seq = existing.reduce((m, e) => Math.max(m, (e as { seq: number }).seq), -1) + 1;
	const chunk = "line of a read file\n".repeat(600); // ~12,000 chars ≈ 3,000 tokens
	// A1b: SETTLED rounds (call, stop, result), as a real log has them — a
	// summary cuts only at a settled round, and a crash-shaped history of
	// stop-less calls is one round still in flight, which no tier may cut.
	// Sixty rounds ≈ 180k: over the 200k window's hard tier (160k), so every
	// door fires whatever the phase; under the 1M window's soft 400k.
	for (let i = 0; i < 60; i++) {
		await store.append(SESSION, "seed", { seq: seq++, type: "tool_call_end", callId: `c${i}`, name: "read_file", input: { path: `f${i}.ts` } } as never);
		await store.append(SESSION, "seed", { seq: seq++, type: "stop", reason: "tool_use" } as never);
		await store.append(SESSION, "seed", { seq: seq++, type: "tool_result", callId: `c${i}`, content: chunk, isError: false } as never);
	}
	// RELEASE THE LOCK. Appending acquires this session's writer lock, and the
	// CLI we are about to drive is a DIFFERENT writer — it refuses with
	// `session s is locked by another writer`. Without this the session never
	// opens, no turn runs, no boundary is written, and the arm that expects
	// no boundary passes for a reason that has nothing to do with the fix.
	store.close(SESSION);
}

/** Rewrite ONLY the recorded model id. Everything the drift check looks at —
 *  the provider, the system prompt digest, the tool hashes — is left exactly
 *  as the CLI wrote it, so the session restores rather than being rebuilt.
 *  `null` leaves the record alone: the SAME-binding arm. */
function recordModel(home: string, modelId: string | null): void {
	if (modelId === null) return;
	const dir = join(home, "sessions");
	const metaName = readdirSync(dir).find((f) => f.endsWith(".meta.json"));
	const path = join(dir, metaName!);
	const meta = JSON.parse(readFileSync(path, "utf8"));
	meta.profile.modelId = modelId;
	if (meta.profile.provider !== null && typeof meta.profile.provider === "object") meta.profile.provider.modelId = modelId;
	writeFileSync(path, `${JSON.stringify(meta, null, 1)}\n`);
}

function boundaries(home: string): number {
	const log = join(home, "sessions", `${SESSION}.jsonl`);
	return readFileSync(log, "utf8").split("\n").filter((l) => l.includes('"type":"summarized"')).length;
}

/** One door, from a clean isolated home: create, seed, record, reopen. */
async function openThrough(args: readonly string[], modelId: string | null): Promise<{ boundaries: number; out: string }> {
	const { env, dirs } = isolatedEnv({ KISO_FAUX_SCRIPT: fauxScript() });

	// F34-R1: EVERY step is asserted to have worked before the boundary
	// count means anything. The first version asserted none of them, and all
	// six continuations were exiting 1 on an exhausted script while the test
	// read 6/6 green. A control does not protect you when it reads the SAME
	// signal as the case: both "a boundary appeared" and "no boundary
	// appeared" survive a run that died, because the boundary is written
	// before the model request.
	const created = runCli(["-p", "first", SESSION], env);
	expect(created.status, `creating the session failed: ${created.stderr}`).toBe(0);

	await seedHistory(dirs.home);
	recordModel(dirs.home, modelId);
	const before = completedTerminals(dirs.home);

	const reopened = runCli([...args], env);
	expect(reopened.status, `${args.join(" ")} failed: ${reopened.stderr}`).toBe(0);
	expect(
		completedTerminals(dirs.home),
		`${args.join(" ")} produced no NEW completed terminal — it did not actually run a turn`,
	).toBeGreaterThan(before);

	return { boundaries: boundaries(dirs.home), out: `${reopened.stdout}${reopened.stderr}` };
}

describe("CTX-1 F34-1: every entry point binds the EFFECTIVE session model's window", () => {
	const doors: readonly (readonly [string, readonly string[]])[] = [
		["kiso -p", ["-p", "continue", SESSION]],
		["kiso resume", ["resume", SESSION, "continue"]],
		["kiso chat", ["chat", SESSION]],
	];

	it.each(doors)("%s: the CONTROL compacts — an unknown model falls back to 200k, so ~180k is over its tiers", async (_name, args) => {
		const r = await openThrough(args, "no-such-model-the-registry-knows");
		expect(r.out, "and the change is said out loud").toContain("binding changed");
		expect(r.boundaries).toBeGreaterThanOrEqual(1);
	}, 60_000);

	it.each(doors)("%s: the SAME binding (the record untouched): no drift is claimed, and the window is the live one", async (_name, args) => {
		const r = await openThrough(args, null);
		expect(r.out, "nothing moved, so nothing is announced").not.toContain("binding changed");
		expect(r.boundaries, "and the ~180k history is still over the 200k window's tiers").toBeGreaterThanOrEqual(1);
	}, 60_000);

	it.each(doors)("%s: a CHANGED binding (recorded 1M, process 200k): the CURRENT binding wins and IS the window", async (_name, args) => {
		// The mixed binding this arm forbids: requests to the 200k model while
		// the 1M window decided when to compact. The ruling of 2026-09-21 made
		// the live binding the subject, so the window moves with it.
		const r = await openThrough(args, "claude-sonnet-5");
		expect(r.out, "the change is stated, not silent").toContain("binding changed");
		expect(r.boundaries, "the LIVE window decides, never the recorded model's").toBeGreaterThanOrEqual(1);
	}, 60_000);
});
