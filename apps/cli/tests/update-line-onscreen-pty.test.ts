/**
 * The update line, ON SCREEN.
 *
 * Everything else about this feature is gated by what it must NOT do —
 * not delay the first frame, not ask twice, not speak where it is
 * unwanted. Nothing asserted the one thing it is FOR: that the line
 * appears, dim, where a reader will see it.
 *
 * That gap is how the first version shipped through `body.notice`,
 * which renders via `ErrorLine` → `escapeTerminal` and strips every SGR
 * it is given. The line was there and it was full-strength prose; no
 * test could tell, because no test looked at the screen.
 *
 * So this looks at the screen, twice: once with the composer idle, and
 * once with a turn already running when the answer arrives. The stub
 * answers immediately — the timing cases are the first-frame gate's job,
 * next door.
 *
 * The stub runs OUT OF PROCESS. `ptyRun` is `spawnSync`, so a server in
 * this process could not accept a connection while the CLI was up — see
 * helpers/registry-stub.ts, which is where that cost a green gate.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnv, runCli } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";
import { startRegistryStub, type RegistryStub } from "./helpers/registry-stub.js";
import { VtScreen } from "./helpers/vt-screen.js";

let stub: RegistryStub | null = null;
afterEach(() => {
	stub?.stop();
	stub = null;
});

const ROWS = 24;
const COLS = 90;

function run(opts: { busy: boolean }): string {
	stub = startRegistryStub("ok");
	const ws = mkdtempSync(join(tmpdir(), "kiso-uline-"));
	writeFileSync(join(ws, "note.txt"), "x\n", "utf8");
	const { env } = isolatedEnv({
		KISO_FAUX_SCRIPT: fauxScript([
			{ events: [{ type: "text_delta", text: "looked." }, { type: "stop", reason: "end_turn" }] },
			...spares(4),
		]),
		KISO_MODE: "bypass",
		KISO_NO_UPDATE_CHECK: "0",
		KISO_UPDATE_ENDPOINT: stub.url,
	});
	// The exit rides the CLOCK, not a needle. The check is fired and
	// forgotten by design, so a session told to leave the moment the
	// composer appears is gone before any answer can arrive — which is
	// the feature working, and would have made this gate unable to see
	// the thing it exists for.
	return ptyRun(["--mode", "bypass", "update-line"], env as NodeJS.ProcessEnv, {
		// busy: a turn is sent at once, so the answer lands mid-turn
		...(opts.busy ? { feeds: [["▌ ", "go\r"]] as [string, string][] } : {}),
		delays: [[opts.busy ? 8 : 5, "exit\r"]],
		timeout: 40,
		rows: ROWS,
		cols: COLS,
		cwd: ws,
	});
}

const screen = (raw: string): string[] => {
	const t = new VtScreen(ROWS, COLS);
	t.write(Buffer.from(raw, "utf8"));
	return t.visible();
};
// OR-9 (owner, 2026-09-09): the update is a CARD under the banner — a rule,
// a bold title, the version with the command that installs it, the
// changelog, a rule — shown at every start while a newer version is known.
const LINE = "New version 99.0.0 is available. Run kiso update";
const TITLE = "Update available";

describe("the update card reaches the screen", () => {
	it("idle: the card sits under the opening's keys row and above the composer", async () => {
		const raw = run({ busy: false });
		const rows = screen(raw).map((r) => r.replace(/\s+$/, ""));
		const at = rows.findIndex((r) => r.includes(LINE));
		expect(at, "the card never reached the screen").toBeGreaterThanOrEqual(0);

		// it follows the opening rather than displacing it
		const keys = rows.findIndex((r) => r.includes("esc interrupt"));
		expect(keys, "no opening on screen").toBeGreaterThanOrEqual(0);
		expect(at, "the line landed above the opening's keys row").toBeGreaterThan(keys);

		// …and the CARD is the last thing the opening says: the title and the
		// opening rule stand over the version line, the changelog and the
		// closing rule under it, and nothing of kiso's own prose follows —
		// which is what "a card, appended" means.
		expect(rows[at - 1], "the title does not stand over the version line").toContain(TITLE);
		expect(rows[at - 2]?.trim(), "no rule opens the card").toMatch(/^\u2500+$/);
		expect(rows[at + 1], "the changelog does not follow the version line").toContain("Changelog: https://github.com/vincemakes/kiso/releases");
		expect(rows[at + 2]?.trim(), "no rule closes the card").toMatch(/^\u2500+$/);
		const lastText = rows.map((r) => r.trim()).reduce((acc, r, i) => (r === "" ? acc : i), -1);
		expect(lastText, "something followed the card").toBe(at + 2);

		// exactly one card in this process — the boot's cache paint and the
		// async check's answer never both land for the same version
		expect(rows.filter((r) => r.includes(LINE))).toHaveLength(1);
		expect(rows.filter((r) => r.includes(TITLE))).toHaveLength(1);

		// the title is BOLD, styled at composition on the raw channel —
		// `body.notice` renders through escapeTerminal and would strip it.
		const i = raw.lastIndexOf(TITLE);
		expect(raw.slice(Math.max(0, i - 12), i), "the title is not bold").toContain("\x1b[1m");
	}, 120_000);

	it("busy: an answer arriving mid-turn lands at the transcript's end, not inside the turn", async () => {
		const raw = run({ busy: true });
		const rows = screen(raw).map((r) => r.replace(/\s+$/, ""));
		const at = rows.findIndex((r) => r.includes(LINE));
		expect(at, "the line never reached the screen").toBeGreaterThanOrEqual(0);
		// the turn's own answer is above it: the line never splits a turn
		const answer = rows.findIndex((r) => r.includes("looked."));
		expect(answer, "no turn on screen").toBeGreaterThanOrEqual(0);
		expect(at, "the line was spliced into the turn").toBeGreaterThan(answer);
	}, 120_000);
});

/**
 * Both legs here SPAWN A REAL CLI, so they declare the same generous bound
 * the PTY leg above declares. They had none and inherited vitest's 5s
 * default, which is a budget a process-spawning test cannot rely on: one of
 * them timed out inside the serial pty pool while passing in 2.4s on its
 * own. Not load — the pool measured 1330.0s, 1331.6s and 1331.8s across
 * three consecutive runs, red and green alike. Real-process tests measure
 * correctness, never speed; the helper's own comment says so.
 */
describe("kiso update — the command the card names", () => {
	function fakeNpm(exit: number): { bin: string; record: string } {
		const bin = mkdtempSync(join(tmpdir(), "kiso-fake-npm-"));
		const record = join(bin, "argv.txt");
		writeFileSync(join(bin, "npm"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\nexit ${exit}\n`, { mode: 0o755 });
		return { bin, record };
	}

	it("runs npm i -g @vincemakes/kiso-code@latest from PATH, inherits its stdio, and reports the install", () => {
		const { bin, record } = fakeNpm(0);
		const { env } = isolatedEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` });
		const r = runCli(["update"], env);
		expect(r.status).toBe(0);
		expect(readFileSync(record, "utf8").trim().split("\n")).toEqual(["i", "-g", "@vincemakes/kiso-code@latest"]);
		expect(r.stdout).toContain("kiso updated");
	}, 120_000);

	it("npm's failure is npm's exit code, and the message names the manual command", () => {
		const { bin } = fakeNpm(3);
		const { env } = isolatedEnv({ PATH: `${bin}:${process.env.PATH ?? ""}` });
		const r = runCli(["update"], env);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("npm i -g @vincemakes/kiso-code@latest");
	}, 120_000);
});
