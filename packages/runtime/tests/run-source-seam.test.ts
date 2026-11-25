/**
 * The run() provenance seam: `run(input, { source })` persists
 * `user_input.source` durably; omitted stays absent. (Kept from the
 * TV-1B round when the task assessment it served was retired with the
 * task extension — the seam itself is the runtime's.)
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFauxProvider, type FauxScript } from "@vincemakes/kiso-evals";
import type { Event } from "@vincemakes/kiso-core";
import { createAgent, SessionStore } from "../src/index.js";

describe("TV-1B ① — the run() provenance seam", () => {
	it("run(input, { source }) persists user_input.source durably; omitted stays absent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-tv1b-seam-"));
		const store = new SessionStore(dir);
		const script: FauxScript = [
			{ events: [{ type: "stop", reason: "end_turn" }] },
			{ events: [{ type: "stop", reason: "end_turn" }] },
		];
		const session = await createAgent({ model: "faux", store, tools: [], adapter: createFauxProvider(script) }).session({ id: "s" });
		for await (const _ of session.run("a plain user line")) {
			/* drain */
		}
		for await (const _ of session.run("Verify the completed work.", { source: "system" })) {
			/* drain */
		}
		await store.closeAll();
		const events = new SessionStore(dir).load("s").map((r) => r.event);
		const inputs = events.filter((e): e is Event & { type: "user_input" } => e.type === "user_input");
		expect(inputs).toHaveLength(2);
		expect(inputs[0]!.source).toBeUndefined();
		expect(inputs[1]!.source).toBe("system");
	});
});
