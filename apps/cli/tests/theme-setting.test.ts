/**
 * The persisted `theme`, and why it is user-level only.
 *
 * §3's ladder degrades to `unknown` when nothing answers, and `unknown`
 * is a real answer rather than a failure — but since the slab it is also
 * the difference between a command block that is a surface and one that
 * is not. A terminal that answers neither `CSI ? 996 n` nor OSC 11 left
 * the human with `KISO_THEME=` on every invocation. This is that answer,
 * written down once.
 *
 * It is USER-level only, and a project file carrying it is a LOUD error
 * rather than a silent win: a terminal is a property of the person
 * sitting at one, not of the repository they happen to have open, and a
 * project that could set it could recolour someone else's screen.
 *
 * LOUD is the discipline for the whole field, both ways. The human sets
 * a theme precisely because their terminal reports nothing, so a value
 * that is quietly ignored looks exactly like the defect it was meant to
 * fix.
 */

import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config.js";

const USER = "~/.kiso/config.json";
const PROJECT = "<cwd>/.kiso/config.json";

describe("the persisted theme", () => {
	it("a user config may carry it, and both values parse", () => {
		expect(parseConfig(JSON.stringify({ theme: "dark" }), USER).theme).toBe("dark");
		expect(parseConfig(JSON.stringify({ theme: "light" }), USER).theme).toBe("light");
	});

	it("absent stays absent — this field never has a default", () => {
		expect(parseConfig("{}", USER).theme).toBeUndefined();
	});

	it("an invalid value is LOUD, and names the field", () => {
		for (const bad of ["Dark", "auto", "", "solarized", 1, null, true]) {
			expect(() => parseConfig(JSON.stringify({ theme: bad }), USER), `theme: ${JSON.stringify(bad)}`).toThrow(ConfigError);
		}
		expect(() => parseConfig(JSON.stringify({ theme: "auto" }), USER)).toThrow(/theme/);
	});

	it("a PROJECT config carrying it is LOUD — even when the value is valid", () => {
		for (const good of ["dark", "light"]) {
			expect(() => parseConfig(JSON.stringify({ theme: good }), PROJECT), `project theme: ${good}`).toThrow(ConfigError);
		}
		expect(() => parseConfig(JSON.stringify({ theme: "dark" }), PROJECT)).toThrow(/USER config/);
	});

	it("it does not disturb the rest of the file", () => {
		const cfg = parseConfig(JSON.stringify({ theme: "light", mode: "plan", contextWindow: 100_000 }), USER);
		expect(cfg.theme).toBe("light");
		expect(cfg.mode).toBe("plan");
		expect(cfg.contextWindow).toBe(100_000);
	});
});
