/**
 * Graphite P1b — kiso's own questions (owner, 2026-09-30): a cold cache, a
 * call that may have run, an unanswered question, and the trust gate open
 * on the question as the band's name, say their sentence once, and quote
 * only what is verbatim. Tool approvals keep the approval layout.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { panelBlockRows } from "../src/ask-panel.js";
import { visibleWidth } from "../src/components.js";
import { Body } from "../src/compositor.js";
import { palette, setGround } from "../src/lines.js";
import { noticeMeta } from "../src/notice-meta.js";
import { coldResumeView, projectTrustView, unansweredAskView, uncertainView, type PanelView } from "../src/index.js";

const plain = (r: string): string => r.replace(/\x1b\[[0-9;]*m/g, "");
const rowsOf = (v: PanelView, W = 80, max = 24): string[] => panelBlockRows(v, "options", 0, W, max);

const COLD = coldResumeView(727_000, 27);
const UNC = uncertainView("shell", "exec-7f3a", ["npm run migrate -- --env staging"]);
const ASK = unansweredAskView("exec-91c2", ["Which database should the migration target?"]);
const TRUST = projectTrustView("/home/me/code/kiso", [{ path: ".kiso/config.json", digest: "3fa9c2e81b" }], "~/code/kiso");

let tty: boolean | undefined;
beforeEach(() => {
	tty = process.stdout.isTTY;
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	delete process.env.NO_COLOR;
	setGround("light");
});
afterEach(() => {
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
	setGround("unknown");
});

describe("P1b — the shape of kiso's own question", () => {
	it("the band is the question, gold, its facts dim; no `needs you`", () => {
		const p = palette();
		const r = rowsOf(COLD);
		expect(plain(r[0]!)).toMatch(/^─{3} compact first\? · 727k tokens · idle 27 min ─+$/);
		expect(r[0]).toContain(`${p.bold}${p.gold}compact first?${p.reset}`);
		expect(r[0]).toContain(`${p.dim} · 727k tokens · idle 27 min${p.reset}`);
		for (const v of [COLD, UNC, ASK, TRUST]) expect(rowsOf(v).map(plain).join("\n")).not.toContain("needs you");
	});

	it("the sentence is said once, at the content edge, and nothing is quoted when nothing is verbatim", () => {
		const r = rowsOf(COLD).map(plain);
		const text = r.join(" ").replace(/\s+/g, " ");
		expect(text.split("727k tokens").length - 1).toBe(2); // the band's fact and the sentence — not three times
		expect(r.slice(1, 4).every((x) => x.startsWith("  ") && !x.startsWith("   "))).toBe(true);
		expect(r.some((x) => x.startsWith("│"))).toBe(false);
		expect(text).not.toContain("cache is cold"); // the old rule line and its quoted copy
	});

	it("a call that may have run quotes the command, never the execution id", () => {
		const r = rowsOf(UNC).map(plain);
		expect(r[0]).toMatch(/^─{3} rerun it\? · shell ─/);
		expect(r).toContain("│ npm run migrate -- --env staging");
		expect(r.join("\n")).not.toContain("exec-7f3a");
		expect(r.join(" ").replace(/\s+/g, " ")).toContain("kiso stopped before this command's result was saved, so it may already have run.");
		// a call that is not a shell command is called a call
		const edit = rowsOf(uncertainView("edit_file", "exec-1", ["src/app.ts"])).map(plain).join(" ").replace(/\s+/g, " ");
		expect(edit).toContain("before this call's result was saved");
	});

	it("an unanswered question quotes the question; two questions are asked about in the plural", () => {
		const r = rowsOf(ASK).map(plain);
		expect(r[0]).toMatch(/^─{3} ask it again\? · never answered ─/);
		expect(r).toContain("│ Which database should the migration target?");
		const two = rowsOf(unansweredAskView("x", ["which bundler?", "which runners?"])).map(plain);
		expect(two[0]).toMatch(/^─{3} ask them again\? · never answered ─/);
		expect(two.join(" ")).toContain("these questions waited for you");
	});

	it("the trust gate: the path on the band, the files quoted, and the answers say what they do", () => {
		const r = rowsOf(TRUST).map(plain);
		expect(r[0]).toMatch(/^─{3} trust this project\? · ~\/code\/kiso ─/);
		expect(r).toContain("│ .kiso/config.json  (3fa9c2)");
		expect(r.some((x) => /1 trust it/.test(x))).toBe(true);
		expect(r.some((x) => /2 not now/.test(x))).toBe(true);
	});

	it("the options, the key row and the closing rule are the approval's own", () => {
		const r = rowsOf(UNC).map(plain);
		expect(r.at(-2)).toMatch(/^ {2}↑↓ move · ⏎ or click confirms · 1-2 instant · esc$/);
		expect(r.at(-1)).toMatch(/^─+$/);
	});

	it("a tool approval keeps the approval layout", () => {
		const approval: PanelView = { flavor: "approval", name: "shell", title: "npm test", speaker: "default", statusText: "❯ run paused", args: { kind: "text", lines: ["npm test"] }, fallbackQuestion: "approve shell? (y/n) " };
		const r = rowsOf(approval).map(plain);
		expect(r[0]).toMatch(/^─{3} needs you ─/);
		expect(r[2]).toBe("  npm test");
		expect(r[3]).toBe("");
	});

	it("the dock-less question is unchanged, word for word", () => {
		expect(COLD.fallbackQuestion).toBe("this session is 727k tokens, last used 27 min ago, and its cache is cold — compact first? (y)es / (n)o ");
		expect(UNC.fallbackQuestion).toBe("interrupted execution: shell (exec-7f3a) — rerun it? (y)es / (n)o ");
		expect(ASK.fallbackQuestion).toBe("an unanswered question was interrupted (exec-91c2) — ask it again? (y)es / (n)o ");
		expect(TRUST.fallbackQuestion).toBe("trust this project's .kiso? (y/n) ");
	});
});

describe("P1b — fit", () => {
	it("invariant ①: every row fits, W 20..200, three grounds, all four questions", () => {
		for (const g of ["light", "dark", "unknown"] as const) {
			setGround(g);
			for (let W = 20; W <= 200; W += 1) {
				for (const v of [COLD, UNC, ASK, TRUST]) for (const r of rowsOf(v, W)) expect(visibleWidth(r), `${g} W=${W} ${v.name}`).toBeLessThanOrEqual(W);
			}
		}
	});

	it("a short budget still shows the selected option and never draws past it", () => {
		for (const v of [COLD, UNC, ASK, TRUST]) {
			for (let max = 8; max <= 20; max += 1) {
				const r = rowsOf(v, 60, max).map(plain);
				expect(r.some((x) => /^ ?[›→] 1 /.test(x)), `${v.name} max=${max}`).toBe(true);
				const chrome = r.findIndex((x) => /^ ?[›→] 1 /.test(x));
				expect(r.length, `${v.name} max=${max}`).toBeLessThanOrEqual(Math.max(max, chrome + 3));
			}
		}
	});
});

describe("P1b — dontAsk leaves a call undecided", () => {
	it("on a dock the line is the UNCERTAIN meta row, said as what it is", () => {
		expect(noticeMeta("[dontAsk] 1 uncertain execution left unresolved — resolve them in an asking mode")).toEqual({ label: "UNCERTAIN", sentence: "1 interrupted command left undecided — asked once don't ask is off" });
		expect(noticeMeta("[dontAsk] 3 uncertain executions left unresolved — resolve them in an asking mode")).toEqual({ label: "UNCERTAIN", sentence: "3 interrupted commands left undecided — asked once don't ask is off" });
	});

	it("a pipe prints the line as it always did", () => {
		const writes: string[] = [];
		const body = new Body({ active: () => false, height: () => 24, width: () => 80, editCol: () => 1, write: (x) => writes.push(x) });
		body.notice("[dontAsk] 1 uncertain execution left unresolved — resolve them in an asking mode");
		expect(writes.join("")).toBe("[dontAsk] 1 uncertain execution left unresolved — resolve them in an asking mode\n");
	});
});
