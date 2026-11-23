import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeMessage, type PeerMessage } from "../src/inbox.js";
import { PeerDelivery } from "../src/peer-delivery.js";
import type { Run } from "../src/run.js";

// ADR-0062 § 10c.1: the host hears of a line the live run accepted, before the log holds it
const msg = (id: string): PeerMessage => ({ messageId: id, from: "k/s", fromTitle: "S", text: id, files: [], rootId: "k/s#0", at: 1 });
const runThat = (accepts: boolean): Run => ({ deliver: () => accepts }) as unknown as Run;

describe("PeerDelivery.onAccepted (§ 10c.1)", () => {
	it("fires once per line a live run accepts, with its id", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-pacc-"));
		await writeMessage(root, "r", msg("m1"));
		const heard: string[] = [];
		const d = new PeerDelivery({ root, sessionId: "r", events: () => [], liveRun: () => runThat(true), onAccepted: (id) => void heard.push(id) });
		expect(d.poke()).toBe("handed");
		expect(d.poke(), "in flight: not handed twice, not heard twice").toBe("handed");
		expect(heard).toEqual(["m1"]);
	});

	it("is silent when the run has decided to end (the line waits), and a throwing hook never breaks the hand-over", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-pacc-"));
		await writeMessage(root, "r", msg("m1"));
		const heard: string[] = [];
		const refused = new PeerDelivery({ root, sessionId: "r", events: () => [], liveRun: () => runThat(false), onAccepted: (id) => void heard.push(id) });
		refused.poke();
		expect(heard).toEqual([]);
		const throwing = new PeerDelivery({ root, sessionId: "r", events: () => [], liveRun: () => runThat(true), onAccepted: () => { throw new Error("boom"); } });
		expect(() => throwing.poke()).not.toThrow();
	});
});
