/**
 * `connecting` is documented as "true while the extension's tool table is still
 * settling" and "live" in the bridge's own header, but the returned object carried
 * the value it had when the factory returned — true forever. Only the startup
 * banner reads it (once), so nothing noticed; anything that waits on it waits for
 * its full bound. It must flip to false when every connect has settled.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import createMcpExtension from "../dist/kiso-mcp.mjs";

const FAKE_SERVER = join(fileURLToPath(new URL(".", import.meta.url)), "fake-server.mjs");

async function until(test: () => boolean, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) { if (test()) return true; await new Promise((r) => setTimeout(r, 20)); }
	return test();
}

describe("the bridge's connecting flag is live", () => {
	it("is true right after the factory returns, and false once the connect has settled", async () => {
		const ext = await createMcpExtension({ servers: { fake: { command: "node", args: [FAKE_SERVER] } } });
		try {
			expect(ext.connecting).toBe(true);
			expect(await until(() => (ext.tools ?? []).some((t: { name: string }) => t.name.startsWith("mcp__fake__")), 8000)).toBe(true);
			expect(await until(() => ext.connecting !== true, 3000)).toBe(true);
			expect(ext.connecting).toBe(false);
		} finally {
			await ext.dispose?.();
		}
	});

	it("also settles when a server cannot be reached (a failed connect is a settled connect)", async () => {
		const ext = await createMcpExtension({ servers: { dead: { command: "node", args: ["-e", "process.exit(1)"] } } });
		try {
			expect(await until(() => ext.connecting !== true, 20000)).toBe(true);
		} finally {
			await ext.dispose?.();
		}
	}, 30000);
});
