/**
 * The update line, and the three things it must never do.
 *
 * The owner's ruling gives the opening ONE line saying a newer kiso
 * exists. Everything expensive about that line is in the machinery
 * around it, so the gates are about the machinery: it must not delay the
 * first frame, must not ask twice in a day, and must not say the same
 * thing twice.
 *
 * Every case here drives a LOCAL stub. The suite never reaches the
 * public registry — a test that touches the network fails for reasons
 * that are not the product's, and `isolatedEnv` turns the check off for
 * every other e2e precisely so this file is the only one that can.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkForUpdate, isNewer, shouldCheck, updateLine } from "../src/update-check.js";

let server: Server | null = null;
let hits = 0;
let home = "";

/** A registry stub. `mode` picks the branch under test. */
async function stub(mode: "ok" | "slow" | "silent" | "malformed" | "500", latest = "9.9.9"): Promise<string> {
	hits = 0;
	server = createServer((req, res) => {
		hits += 1;
		if (mode === "silent") return; // never answers: the timeout's case
		if (mode === "slow") {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ latest }));
			}, 5_000);
			return;
		}
		if (mode === "500") {
			res.writeHead(500);
			res.end("nope");
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(mode === "malformed" ? "{{{not json" : JSON.stringify({ latest }));
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
	const port = (server!.address() as { port: number }).port;
	return `http://127.0.0.1:${port}/dist-tags`;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "kiso-upd-"));
	delete process.env.KISO_NO_UPDATE_CHECK;
});
afterEach(async () => {
	delete process.env.KISO_UPDATE_ENDPOINT;
	delete process.env.KISO_NO_UPDATE_CHECK;
	if (server !== null) await new Promise<void>((r) => server!.close(() => r()));
	server = null;
});

const deps = (over: Partial<Parameters<typeof checkForUpdate>[0]> = {}) => ({ kisoHome: home, version: "0.22.0", isTTY: true, faux: false, ...over });
const cache = (): Record<string, unknown> => JSON.parse(readFileSync(join(home, "update-check.json"), "utf8"));

describe("is it newer at all", () => {
	it("compares the three parts, and a prerelease of the same numbers is not newer", () => {
		expect(isNewer("0.22.0", "0.23.0")).toBe(true);
		expect(isNewer("0.22.0", "1.0.0")).toBe(true);
		expect(isNewer("0.22.0", "0.22.1")).toBe(true);
		expect(isNewer("0.22.0", "0.22.0")).toBe(false);
		expect(isNewer("0.23.0", "0.22.9")).toBe(false);
		expect(isNewer("0.22.0", "0.22.0-rc.1")).toBe(false);
	});

	it("a version it cannot parse is never newer — the failure direction is silence", () => {
		expect(isNewer("0.22.0", "latest")).toBe(false);
		expect(isNewer("0.22.0", "")).toBe(false);
		expect(isNewer("nightly", "0.23.0")).toBe(false);
	});
});

describe("who never asks", () => {
	it("an explicit opt-out, a faux session, and a pipe", () => {
		process.env.KISO_NO_UPDATE_CHECK = "1";
		expect(shouldCheck(deps())).toBe(false);
		delete process.env.KISO_NO_UPDATE_CHECK;
		expect(shouldCheck(deps({ faux: true })), "a faux session never reaches the network").toBe(false);
		expect(shouldCheck(deps({ isTTY: false })), "a pipe has no banner to append to").toBe(false);
		expect(shouldCheck(deps()), "and otherwise it does ask").toBe(true);
	});
});

/**
 * The cache is not a way around the three answers.
 *
 * `shouldCheck` is false for four reasons and only ONE of them is about
 * the request. An opt-out is an answer about the feature; a faux session
 * is a test or a demo; a pipe has no banner — and an inactive Body
 * writes a notice straight to stdout, so speaking there would put a row
 * of kiso's own prose into piped bytes. Each was reachable through the
 * cached path once, which is the defect these three cases pin.
 */
describe("GATE — a stored update is not announced where the LINE is unwanted", () => {
	/** a cache that is fresh AND carries an unannounced newer version:
	 *  the exact state that used to speak regardless of the reason */
	const primed = (): void => {
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest: "9.9.9" }));
	};

	it("an opt-out stays silent, though the cache has something to say", async () => {
		primed();
		process.env.KISO_NO_UPDATE_CHECK = "1";
		expect(await checkForUpdate(deps())).toBeNull();
	});

	it("a faux session stays silent — with no test seam set, which is production", async () => {
		primed();
		expect(process.env.KISO_UPDATE_ENDPOINT, "the seam must be absent for this to mean anything").toBeUndefined();
		expect(await checkForUpdate(deps({ faux: true }))).toBeNull();
		expect(shouldCheck(deps({ faux: true }))).toBe(false);
	});

	it("a PIPE stays silent — a notice there is a row of prose in piped bytes", async () => {
		primed();
		expect(await checkForUpdate(deps({ isTTY: false }))).toBeNull();
	});

	it("…and a merely RECENT check still speaks, which is the one reason that is about the request", async () => {
		primed();
		expect(await checkForUpdate(deps())).toBe(updateLine("9.9.9"));
	});
});

describe("GATE — a cache inside the window sends NO request", () => {
	it("the stub is never hit when the last check was an hour ago", async () => {
		process.env.KISO_UPDATE_ENDPOINT = await stub("ok");
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 60 * 60 * 1_000 }));
		expect(shouldCheck(deps())).toBe(false);
		await checkForUpdate(deps());
		expect(hits, "a cached check still went to the network").toBe(0);
	});

	it("…and a stale cache does ask again", async () => {
		process.env.KISO_UPDATE_ENDPOINT = await stub("ok");
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 25 * 60 * 60 * 1_000 }));
		await checkForUpdate(deps());
		expect(hits).toBe(1);
	});
});

describe("GATE — the same version is announced exactly once", () => {
	it("the second launch says nothing, though the registry says the same thing", async () => {
		process.env.KISO_UPDATE_ENDPOINT = await stub("ok", "0.23.0");
		expect(await checkForUpdate(deps())).toBe(updateLine("0.23.0"));
		expect(cache().told).toBe("0.23.0");
		// a day later, same answer
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ ...cache(), checkedAt: Date.now() - 25 * 60 * 60 * 1_000 }));
		expect(await checkForUpdate(deps()), "the same version was announced twice").toBeNull();
	});

	it("but a NEWER one is announced", async () => {
		writeFileSync(join(home, "update-check.json"), JSON.stringify({ checkedAt: Date.now() - 25 * 60 * 60 * 1_000, latest: "0.23.0", told: "0.23.0" }));
		process.env.KISO_UPDATE_ENDPOINT = await stub("ok", "0.24.0");
		expect(await checkForUpdate(deps())).toBe(updateLine("0.24.0"));
	});
});

describe("GATE — every failure is silence", () => {
	it("a stub that never answers times out and says nothing", async () => {
		process.env.KISO_UPDATE_ENDPOINT = await stub("silent");
		const t0 = Date.now();
		expect(await checkForUpdate(deps())).toBeNull();
		// the abort fires at 1.5s; the point is that it RETURNS, bounded
		expect(Date.now() - t0, "the check did not bound itself").toBeLessThan(4_000);
		expect(cache().checkedAt, "a failed check still records that it tried").toBeGreaterThan(0);
	}, 20_000);

	it("a slow answer, a 500 and a malformed body are all silence", async () => {
		for (const mode of ["slow", "500", "malformed"] as const) {
			if (server !== null) await new Promise<void>((r) => server!.close(() => r()));
			home = mkdtempSync(join(tmpdir(), "kiso-upd-"));
			process.env.KISO_UPDATE_ENDPOINT = await stub(mode);
			expect(await checkForUpdate(deps()), `mode=${mode}`).toBeNull();
		}
	}, 30_000);

	it("an unreachable endpoint says nothing either", async () => {
		process.env.KISO_UPDATE_ENDPOINT = "http://127.0.0.1:1/dist-tags";
		expect(await checkForUpdate(deps())).toBeNull();
	});
});

describe("the line itself", () => {
	it("is words a human can paste, and needs no colour to be understood", () => {
		expect(updateLine("0.23.0")).toBe("0.23.0 is out · npm i -g @vincemakes/kiso-code@latest");
	});

	it("says nothing when the registry is not ahead of us", async () => {
		process.env.KISO_UPDATE_ENDPOINT = await stub("ok", "0.22.0");
		expect(await checkForUpdate(deps())).toBeNull();
	});
});
