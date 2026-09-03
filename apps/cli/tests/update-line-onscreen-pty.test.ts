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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
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
const LINE = "99.0.0 is out · npm i -g @vincemakes/kiso-code@latest";

describe("the update line reaches the screen, dim", () => {
	it("idle: it sits under the opening's keys row and above the composer", async () => {
		const raw = run({ busy: false });
		const rows = screen(raw).map((r) => r.replace(/\s+$/, ""));
		const at = rows.findIndex((r) => r.includes(LINE));
		expect(at, "the line never reached the screen").toBeGreaterThanOrEqual(0);

		// it follows the opening rather than displacing it
		const keys = rows.findIndex((r) => r.includes("esc interrupt"));
		expect(keys, "no opening on screen").toBeGreaterThanOrEqual(0);
		expect(at, "the line landed above the opening's keys row").toBeGreaterThan(keys);

		// …and it is the LAST thing the opening says: nothing of kiso's own
		// prose follows it, which is what "one line, appended" means.
		const lastText = rows.map((r) => r.trim()).reduce((acc, r, i) => (r === "" ? acc : i), -1);
		expect(lastText, "something followed the update line").toBe(at);

		// exactly one of it — a line announced twice is the defect the
		// `told` field exists to prevent, seen from the screen's side
		expect(rows.filter((r) => r.includes(LINE))).toHaveLength(1);

		// DIM, which is the whole reason it left `body.notice`: that path
		// renders through escapeTerminal and would have stripped this.
		const i = raw.lastIndexOf(LINE);
		expect(raw.slice(Math.max(0, i - 40), i), "the line is not dim").toMatch(/\x1b\[(2|38;5;\d+)m/);
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
