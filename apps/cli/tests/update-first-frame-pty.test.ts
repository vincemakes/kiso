/**
 * THE BLOCKER for the update line: the first frame must not know the
 * check exists.
 *
 * The line is a courtesy. The opening is not — it is the thing a human
 * waits for, and design.md §7.10 describes it as three labelled facts
 * answered from what kiso already knows. A version check that delayed
 * it, or changed a byte of it, would have traded the product's own
 * opening for a convenience.
 *
 * So this compares BYTES: the same session with the check off, with the
 * check on against a stub that answers too slowly to matter, and with
 * the check on against a stub that never answers at all. The three
 * openings must be identical up to the first frame's close.
 *
 * The stub is local. The suite never reaches the public registry —
 * `isolatedEnv` switches the check off for every other e2e so this file
 * is the only place it runs, and even here it is pointed at 127.0.0.1.
 */

import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

let server: Server | null = null;
afterEach(async () => {
	if (server !== null) await new Promise<void>((r) => server!.close(() => r()));
	server = null;
});

/** A registry stub that is deliberately useless: it either answers long
 *  after the opening is drawn, or never. */
async function uselessStub(mode: "slow" | "silent"): Promise<string> {
	server = createServer((_req, res) => {
		if (mode === "silent") return;
		setTimeout(() => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ latest: "99.0.0" }));
		}, 10_000);
	});
	await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
	return `http://127.0.0.1:${(server!.address() as { port: number }).port}/dist-tags`;
}

/** Everything up to and including the first frame's close — the opening
 *  as the terminal receives it. */
function firstFrame(raw: string): string {
	const CLOSE = "\x1b[?2026l";
	const i = raw.indexOf(CLOSE);
	return i < 0 ? raw : raw.slice(0, i + CLOSE.length);
}

function open(extra: Record<string, string>): string {
	const ws = mkdtempSync(join(tmpdir(), "kiso-uff-"));
	writeFileSync(join(ws, "note.txt"), "x\n", "utf8");
	const { env } = isolatedEnv({
		KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: "hi." }, { type: "stop", reason: "end_turn" }] }, ...spares(3)]),
		KISO_MODE: "bypass",
		...extra,
	});
	return ptyRun(["--mode", "bypass", "update-first-frame"], env as NodeJS.ProcessEnv, {
		feeds: [["▌ ", "exit\r"]],
		timeout: 30,
		cwd: ws,
	});
}

describe("the update check never touches the first frame", () => {
	it("slow stub and silent stub both leave the opening byte-identical", async () => {
		// the control: the check is off, which is what every other e2e runs
		const off = firstFrame(open({ KISO_NO_UPDATE_CHECK: "1" }));
		expect(off.length, "no first frame at all").toBeGreaterThan(0);

		for (const mode of ["slow", "silent"] as const) {
			if (server !== null) await new Promise<void>((r) => server!.close(() => r()));
			const endpoint = await uselessStub(mode);
			const on = firstFrame(open({ KISO_NO_UPDATE_CHECK: "0", KISO_UPDATE_ENDPOINT: endpoint }));
			expect(on, `mode=${mode}: the opening's bytes moved`).toBe(off);
		}
	}, 180_000);
});
