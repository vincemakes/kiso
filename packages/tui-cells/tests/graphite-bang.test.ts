/**
 * Graphite §7.13 (G3, R2d) — the person's own shell: `!!cmd` is a command
 * card saying `not sent`; a `!cmd` turn (the fenced block it sends) draws
 * as the same card saying `sent to the model`. The model's bytes are not
 * this file's subject — bang-command-pty holds that line.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { bangOf, cellComponent, type FrameCtx } from "../src/components.js";
import { palette, setGround } from "../src/render.js";
import { visibleWidth } from "../src/width.js";

beforeAll(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
});
afterEach(() => setGround("unknown"));

const CTX: FrameCtx = { spinnerI: 0, now: 10_000, height: 40 };
const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const shown = (command: string, output: string, isError = false, W = 80): string[] => cellComponent({ kind: "bang", command, output, isError, done: true } as never).render(W, CTX);
const sent = (text: string, W = 80): string[] => cellComponent({ kind: "user", text } as never).render(W, CTX);
const fence = (command: string, output: string): string => ["```console", `$ ${command}`, output, "```"].join("\n");

describe("the block `!cmd` sends", () => {
	it("is recognised, and nothing else is", () => {
		expect(bangOf(fence("ls", "a\nb"))).toEqual({ command: "ls", output: "a\nb" });
		expect(bangOf(fence("true", ""))).toEqual({ command: "true", output: "" });
		expect(bangOf("```console\nls\n```")).toBeNull();
		expect(bangOf("please run ls")).toBeNull();
	});
});

describe("the card", () => {
	it("`!!`: `$ <command>` with `not sent` at the right, the output under the command, on the warm ground", () => {
		setGround("light");
		const p = palette();
		const rows = shown("git status --short", " M src/a.ts\n?? notes.md\n");
		expect(rows).toHaveLength(5);
		expect(plain(rows[1]!)).toMatch(/^ {2}\$ git status --short +not sent {2}$/);
		expect(rows[1]).toContain(`${p.bold}$ git status --short`);
		expect(rows.slice(2, 4).map((r) => plain(r).trimEnd())).toEqual(["     M src/a.ts", "    ?? notes.md"]);
		for (const r of rows) {
			expect(r.startsWith(p.humanEdge)).toBe(true);
			expect(visibleWidth(r)).toBe(80);
		}
	});

	it("a failure names its exit code, then its fate", () => {
		setGround("light");
		expect(plain(shown("ls nope", "exit 1: ls: nope: No such file", true)[1]!)).toMatch(/exit 1 · not sent {2}$/);
		expect(plain(sent(fence("ls nope", "exit 1: ls: nope: No such file"))[1]!)).toMatch(/exit 1 · sent to the model {2}$/);
	});

	it("`!`: the sent turn draws as the same card, its output capped at twelve rows from the END, with the count above", () => {
		setGround("light");
		const out = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
		const rows = sent(fence("seq 30", out)).map((r) => plain(r).trimEnd());
		expect(rows[1]).toMatch(/^ {2}\$ seq 30 +sent to the model$/);
		expect(rows[2]).toBe("    … 18 earlier lines");
		expect(rows.slice(3, 15)).toEqual(Array.from({ length: 12 }, (_, i) => `    row ${i + 19}`));
		expect(rows.join("\n")).not.toContain("```");
	});

	it("the output is escaped like a tool's: a terminal sequence in it never reaches the terminal", () => {
		setGround("light");
		const rows = shown("printf evil", "\x1b]0;owned\x07title\x1b[2Jclear").join("");
		expect(rows).not.toContain("\x1b]0;owned");
		expect(rows).not.toContain("\x1b[2J");
	});

	it("off a known ground: the same words, no surface", () => {
		setGround("unknown");
		const rows = shown("ls", "a").map(plain);
		expect(rows[0]).toMatch(/^ {2}\$ ls +not sent$/);
		expect(rows[1]).toBe("    a");
	});

	it("invariant ①: every row fits, W 20..200, on both grounds and the unknown one", () => {
		const long = `echo ${"x".repeat(120)}`;
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) {
				for (const r of [...shown(long, "y".repeat(300), false, W), ...sent(fence(long, "z".repeat(300)), W)]) expect(visibleWidth(r), `${g} W=${W}: ${plain(r)}`).toBeLessThanOrEqual(W);
			}
		}
	});
});
