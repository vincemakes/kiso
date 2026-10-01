/**
 * 0.40.0 (the owner's dogfood) — dontAsk offers no ask_user. Since the
 * modes round dontAsk is a switch beside the tier, and this holds in every
 * tier: with the switch on, nothing offers ask_user.
 *
 * A dontAsk session on a TTY loaded the ask extension, the model put four
 * questions to it, and every one was declined. The gate is LIVE
 * (builtin.ts offInDontAsk): the registry reads an extension's tools on
 * every request, so these assertions run against ONE registry across mode
 * switches, the way a session sees it.
 *
 * The identity claim is against the pipe path — the session that never
 * constructs the ask extension at all. In dontAsk, a TTY session's
 * composed tool table (snippet and guidelines included) and the specs a
 * request advertises must be byte-identical to it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "@vincemakes/kiso-core";
import { composeToolTable } from "@vincemakes/kiso-runtime/internal";
import { extensionsBannerText } from "@vincemakes/kiso-tui";
import type { KisoExtension } from "@vincemakes/kiso-runtime";
import { builtInLayer } from "../src/builtin.js";
import { applyModeSetting, getDontAsk, getMode, parseMode, setDontAsk, setMode } from "../src/mode.js";

const ui = { ask: async () => ({ declined: [] }) };

/** The agent's own registration (agent.ts): every extension's tools as a
 *  LIVE source, never a snapshot. */
function registryOf(exts: readonly KisoExtension[]): ToolRegistry {
	const r = new ToolRegistry();
	for (const ext of exts) r.registerLive(() => ext.tools ?? [], ext.name);
	return r;
}

const specNames = (r: ToolRegistry): string[] => r.snapshot().specs.map((s) => s.name);

const initial = getMode();
const initialSwitch = getDontAsk();
afterEach(() => {
	setMode(initial);
	setDontAsk(initialSwitch);
});

describe("dontAsk — the tool table never offers ask_user", () => {
	it("with the switch on, a TTY session's table and specs are byte-identical to the pipe path's", async () => {
		const pipe = registryOf(await builtInLayer([], []));
		const tty = registryOf(await builtInLayer([], [], ui));
		setDontAsk(true);
		expect(specNames(tty)).not.toContain("ask_user");
		expect(composeToolTable(tty)).toBe(composeToolTable(pipe));
		expect(JSON.stringify(tty.snapshot().specs)).toBe(JSON.stringify(pipe.snapshot().specs));
		expect(composeToolTable(tty)).not.toMatch(/ask_user/);
	});

	it("the gate is live: turning the switch off brings ask_user back on the SAME registry, turning it on takes it away", async () => {
		const tty = registryOf(await builtInLayer([], [], ui));
		setDontAsk(true);
		expect(specNames(tty)).not.toContain("ask_user");
		setDontAsk(false);
		expect(specNames(tty)).toContain("ask_user");
		expect(composeToolTable(tty)).toMatch(/- ask_user — /);
		expect(tty.get("ask_user")).toBeDefined();
		setDontAsk(true);
		expect(specNames(tty)).not.toContain("ask_user");
		expect(tty.get("ask_user")).toBeUndefined();
	});

	it("the switch decides, not the tier: off, every tier keeps ask_user; on, none offers it — full-access included", async () => {
		const tty = registryOf(await builtInLayer([], [], ui));
		for (const m of ["default", "accept-edits", "plan", "full-access"] as const) {
			setMode(m);
			setDontAsk(false);
			expect(specNames(tty), m).toContain("ask_user");
			setDontAsk(true);
			expect(specNames(tty), `${m} · don't ask`).not.toContain("ask_user");
		}
	});

	it("the old name: `dontAsk` takes ask_user away, and leaving that tier brings it back, as it always did", async () => {
		const tty = registryOf(await builtInLayer([], [], ui));
		setDontAsk(false);
		applyModeSetting(parseMode("dontAsk")!);
		expect(getMode()).toBe("default");
		expect(specNames(tty)).not.toContain("ask_user");
		setMode("default");
		expect(specNames(tty)).toContain("ask_user");
	});

	it("the extension stays loaded and named — only its tool goes", async () => {
		setDontAsk(true);
		const built = await builtInLayer([], [], ui);
		expect(built.map((e) => e.name)).toEqual(["mcp", "skills", "subagent", "ask"]);
		expect(built.find((e) => e.name === "ask")!.tools).toEqual([]);
	});
});

describe("the banner names what turned it off", () => {
	it("a note prints in parentheses after the name; connecting still wins", () => {
		expect(extensionsBannerText([{ name: "mcp" }, { name: "ask", note: "off in dontAsk" }], [], [])).toBe(
			" · [2 extensions: built-in: mcp, ask (off in dontAsk)]",
		);
		expect(extensionsBannerText([{ name: "mcp", connecting: true, note: "x" }], [], [])).toBe(" · [1 extension: built-in: mcp (connecting…)]");
	});
});
