/**
 * KC3.5 T-Q3 — the TTY gate, and the extraction's zero-behavior proof.
 *
 * THE BENCH PROOF IS STRUCTURAL. The round adds a tool, and a tool costs
 * prompt tokens on every request that carries it. The claim "the bench
 * stays byte-identical" is therefore not a measurement here but a
 * SHAPE: a piped session's composed tool table cannot contain ask_user,
 * because the extension that would carry it is never constructed with a
 * bridge — and with no bridge it has no tool at all. That is asserted at
 * the composition (builtInLayer) and again end to end through the
 * BANNER, which counts what actually loaded: 4 built-ins on a TTY, 3 on
 * a pipe.
 *
 * Slice ⓪'s extraction is pinned in the same file because it is the
 * other half of the same bargain: the cli made room for the bridge by
 * moving presentation out, and "presentation moved" must mean the bytes
 * did not change. The /help rows and the banner text are pinned against
 * HAND-TRANSCRIBED literals — transcribed from the pre-move source, not
 * generated from the post-move code (a generated pin proves nothing).
 */

import { describe, expect, it } from "vitest";
import { extensionsBannerText, helpRows } from "@vincemakes/kiso-tui";
import { builtInLayer } from "../src/builtin.js";
import { isolatedEnv, runCli, stripANSI } from "../../../tests/helpers/isolated-cli.mjs";

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

/** A bridge stands in for the cli's own — the gate is the ARGUMENT's
 *  presence, never the implementation behind it. */
const ui = { ask: async () => ({ declined: [] }) };

describe("T-Q3 — the composed tool table: ask_user exists only where a human can answer", () => {
	it("NO bridge (the pipe path): three built-ins, and NO ask_user anywhere in the table", async () => {
		const built = await builtInLayer([], []);
		expect(built.map((e) => e.name)).toEqual(["mcp", "skills", "subagent"]);
		const tools = built.flatMap((e) => (e.tools ?? []).map((t) => t.name));
		expect(tools).not.toContain("ask_user");
	});

	it("WITH a bridge (the TTY path): four built-ins, and ask_user is the fourth's only tool", async () => {
		const built = await builtInLayer([], [], ui);
		expect(built.map((e) => e.name)).toEqual(["mcp", "skills", "subagent", "ask"]);
		expect(built.find((e) => e.name === "ask")!.tools!.map((t) => t.name)).toEqual(["ask_user"]);
	});

	it("the ask joins the cascade like any built-in: a user extension named `ask` shadows it", async () => {
		const built = await builtInLayer([{ name: "ask" }], [], ui);
		expect(built.map((e) => e.name)).toEqual(["mcp", "skills", "subagent"]);
	});

	it("...and the project layer may not shadow it — the same refusal the other three get", async () => {
		await expect(builtInLayer([], [{ name: "ask" }], ui)).rejects.toThrow(/extension name "ask" exists in both/);
	});
});

describe("T-Q3 — the banner counts what loaded: 4 on a TTY, 3 on a pipe", () => {
	it("a PIPED session reads three built-ins — the historical line, unchanged", () => {
		const { env } = isolatedEnv();
		const res = runCli(["chat", "pipe-gate"], env, { input: "exit\n" });
		expect(stripANSI(res.stdout)).toContain("[3 extensions: built-in: mcp, skills, subagent]");
		expect(stripANSI(res.stdout)).not.toContain("ask");
	});

	it("the banner composition itself: the ask is the fourth name, and only when it loaded", () => {
		const three = [{ name: "mcp" }, { name: "skills" }, { name: "subagent" }];
		expect(extensionsBannerText(three, [], [])).toBe(" · [3 extensions: built-in: mcp, skills, subagent]");
		expect(extensionsBannerText([...three, { name: "ask" }], [], [])).toBe(
			" · [4 extensions: built-in: mcp, skills, subagent, ask]",
		);
	});
});

describe("T-Q3 / slice ⓪ — the extraction changed no bytes", () => {
	it("the /help rows are the eight extracted rows PLUS the mini-spec pair", () => {
		// DC-1 supersession: the gap was four spaces after the name whatever
		// the name's length, so `/help`'s description began three columns
		// left of `/compact`'s and the second column wandered down the list.
		// It is one computed stop now — max(name) + 4 — so the WORDS are
		// still the hand-transcribed pre-move literals and only the padding
		// moved. TUI2-R1 (D) froze the keys SENTENCE, not the alignment.
		// hand-transcribed from the pre-move dispatch.ts (0.7.0, 6707f0a);
		// /clear and /resume joined at the resume+clear mini-spec round —
		// a DECLARED ADDITION, the pre-move rows keep their exact bytes.
		// /rewrap joined at R4 (C4d) — the same kind of declared addition.
		// The computed stop is max(name) + 4 and `/compact` is still the
		// longest name, so every pre-move row keeps its exact padding too.
		expect(helpRows().map(plain)).toEqual([
			"/help       print this list of commands",
			"/think      show the last full thinking block",
			"/last       show the most recent tool call's input and output",
			"/rewrap     re-print the recent prose at the current width",
			"/status     show session id, event count, and context estimate",
			"/mode       show the approval tier; /mode <name> switches (manual/default/accept-edits/plan/bypass)",
			"/model      list model profiles; /model <name|provider/model> switches",
			"/compact    summarize the older conversation to free context",
			"/clear      start a fresh conversation (the old session stays resumable)",
			"/resume     switch to another session; /resume <id> goes directly",
			// slice ⑥ appends the ask gesture to the keys row — the KC1/KC2/KC3
			// precedent (the row is where a gesture is taught, and the row
			// costs nothing). Everything before " · 1-4 answers an ask" is
			// the hand-transcribed pre-move literal.
			"exit        leave the session\nkeys        enter sends \u00b7 ctrl+J newline (shift+enter where encoded) \u00b7 esc stops the run \u00b7 alt+\u23ce stops it and sends this instead \u00b7 @ files \u00b7 1-4 answers an ask",
		]);
	});

	it("the last row still carries its own newline — two rows from one bodyLog call", () => {
		expect(helpRows()).toHaveLength(11); // 8 extracted + the mini-spec pair + /rewrap (R4)
		expect(helpRows().filter((r) => r.includes("\n"))).toHaveLength(1);
	});

	it("the banner text is exactly what the inline composition produced — every branch", () => {
		// hand-transcribed from the pre-move index.ts (0.7.0, 6707f0a)
		expect(extensionsBannerText([], [], [])).toBe("");
		expect(extensionsBannerText([], [{ name: "x" }], [])).toBe(" · [1 extension: x]");
		expect(extensionsBannerText([{ name: "mcp" }], [{ name: "x" }], [{ name: "lint-rules" }])).toBe(
			" · [3 extensions: built-in: mcp · x · project: lint-rules]",
		);
		expect(extensionsBannerText([{ name: "mcp", connecting: true }], [], [])).toBe(
			" · [1 extension: built-in: mcp (connecting…)]",
		);
	});
});
