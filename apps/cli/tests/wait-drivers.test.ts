/**
 * ADR-0059 release 1 — the CLI's GitHub wait drivers over a FAKE `gh`: a
 * script on disk that answers `pr view` and `pr checks` from files the
 * test rewrites. No network, no real GitHub (the bench rule).
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ghChecksDriver, ghReviewDriver } from "../src/wait-drivers.js";

function fakeGh(): { readonly bin: string; readonly dir: string; readonly errors: Error[]; view: (v: unknown) => void; checks: (c: unknown) => void; calls: () => number } {
	const dir = mkdtempSync(join(tmpdir(), "kiso-fake-gh-"));
	const errors: Error[] = [];
	const bin = join(dir, "gh");
	writeFileSync(
		bin,
		`#!/bin/sh
case "$1 $2" in
  "pr view") cat "${dir}/view.json" ;;
  "pr checks") cat "${dir}/checks.json" ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
# counted AFTER the answer went out: a counted call has already been read,
# so a test that rewrites the files after it cannot race the read
echo 1 >> "${dir}/calls"
`,
	);
	chmodSync(bin, 0o755);
	writeFileSync(join(dir, "calls"), "");
	return {
		bin,
		dir,
		errors,
		view: (v) => writeFileSync(join(dir, "view.json"), JSON.stringify(v)),
		checks: (c) => writeFileSync(join(dir, "checks.json"), JSON.stringify(c)),
		calls: () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean).length,
	};
}

/** The fake has been asked at least `n` times (timing under load is not the test's). */
async function untilCalls(gh: { calls: () => number; errors: Error[] }, n: number): Promise<void> {
	for (let i = 0; i < 200 && gh.calls() < n; i += 1) await new Promise((r) => setTimeout(r, 10));
	expect(gh.calls(), `probe errors: ${gh.errors.map((e) => e.message).join(" | ") || "none"}`).toBeGreaterThanOrEqual(n);
}

const wait = (source: Record<string, unknown>) => ({ id: "t1", source: { kind: "gh-checks", ...source }, deadlineAt: Date.now() + 10_000, plannedAt: Date.now() });

describe("gh-checks", () => {
	it("fires once every check has a conclusion, with the head sha as the version and the checks verbatim; pending is not a conclusion", { timeout: 20_000 }, async () => {
		const gh = fakeGh();
		gh.view({ headRefOid: "abc123" });
		gh.checks([{ name: "build", state: "IN_PROGRESS", bucket: "pending" }]);
		const driver = ghChecksDriver({ gh: gh.bin, pollMs: 30, cwd: gh.dir, onError: (e) => void gh.errors.push(e) });
		const controller = new AbortController();
		const fired = driver.arm(wait({ pr: 207, repo: "o/r" }), controller.signal);
		await untilCalls(gh, 2); // the first probe has read "pending"
		gh.checks([
			{ name: "build", state: "FAILURE", bucket: "fail", link: "https://x/1" },
			{ name: "test", state: "SUCCESS", bucket: "pass" },
		]);
		const ev = await fired;
		expect(ev.eventId).toBe("gh-checks:207:sha:abc123:build=fail,test=pass");
		expect(ev.payload).toEqual({
			subject: "github:pr#207",
			version: "sha:abc123",
			checks: [
				{ name: "build", state: "FAILURE", bucket: "fail", link: "https://x/1" },
				{ name: "test", state: "SUCCESS", bucket: "pass" },
			],
		});
		expect(gh.calls()).toBeGreaterThanOrEqual(4); // the pending poll, then the one that fired
		expect(gh.errors).toEqual([]);
	});

	it("an abort stops the polling and rejects", async () => {
		const gh = fakeGh();
		gh.view({ headRefOid: "abc" });
		gh.checks([]);
		const controller = new AbortController();
		const p = ghChecksDriver({ gh: gh.bin, pollMs: 20, cwd: gh.dir, onError: (e) => void gh.errors.push(e) }).arm(wait({ pr: 1 }), controller.signal);
		await new Promise((r) => setTimeout(r, 60));
		controller.abort();
		await expect(p).rejects.toThrow("aborted");
		const n = gh.calls();
		await new Promise((r) => setTimeout(r, 80));
		expect(gh.calls()).toBe(n); // nothing after the abort
	});

	it("a source without a pr is refused at arm time", () => {
		const gh = fakeGh();
		expect(() => ghChecksDriver({ gh: gh.bin, cwd: gh.dir, onError: (e) => void gh.errors.push(e) }).arm(wait({}), new AbortController().signal)).toThrow(/needs \{ pr/);
	});
});

describe("gh-review", () => {
	it("what exists at registration is not news; a new review or comment fires, carrying only the new ones", { timeout: 20_000 }, async () => {
		const gh = fakeGh();
		gh.view({ headRefOid: "h1", reviews: [{ id: "R1", state: "APPROVED", author: { login: "a" } }], comments: [{ id: "C1", author: { login: "b" } }] });
		const driver = ghReviewDriver({ gh: gh.bin, pollMs: 30, cwd: gh.dir, onError: (e) => void gh.errors.push(e) });
		const fired = driver.arm({ ...wait({ pr: 207 }), source: { kind: "gh-review", pr: 207 } }, new AbortController().signal);
		await untilCalls(gh, 1); // the baseline is taken
		gh.view({
			headRefOid: "h2",
			reviews: [
				{ id: "R1", state: "APPROVED", author: { login: "a" } },
				{ id: "R2", state: "CHANGES_REQUESTED", author: { login: "c" }, submittedAt: "2026-10-06T00:00:00Z" },
			],
			comments: [{ id: "C1", author: { login: "b" } }],
		});
		const ev = await fired;
		expect(ev.eventId).toBe("gh-review:207:review:R2");
		expect(ev.payload).toEqual({
			subject: "github:pr#207",
			version: "sha:h2",
			reviews: [{ id: "R2", state: "CHANGES_REQUESTED", author: "c", submittedAt: "2026-10-06T00:00:00Z" }],
			comments: [],
		});
		expect(gh.errors).toEqual([]);
	});
});
