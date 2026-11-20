import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeMessage, type PeerMessage } from "../src/inbox.js";
import { PeerDelivery } from "../src/peer-delivery.js";

// finding G2: a wake that fails must not leave the delivery believing a wake is starting
const msg = (id: string, rootId = "k/s#0"): PeerMessage => ({ messageId: id, from: "k/s", fromTitle: "S", text: id, files: [], rootId, at: 1 });
const settle = () => new Promise((r) => setTimeout(r, 10));

describe("PeerDelivery when a wake fails (finding G2)", () => {
	it("a wake that rejects clears the waking state: the next look wakes again, and never answers 'woke' for nothing", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-pwf-"));
		await writeMessage(root, "r", msg("m1"));
		const wakes: string[] = [];
		let fail = true;
		const d = new PeerDelivery({
			root, sessionId: "r", events: () => [], liveRun: () => undefined,
			onWake: (w) => { wakes.push(w.via.kind === "peer" ? w.via.messageId : "?"); return fail ? Promise.reject(new Error("the Work could not be opened")) : Promise.resolve(); },
		});
		expect(d.poke()).toBe("woke");
		await settle();
		fail = false;
		expect(d.poke(), "the failed wake is over; this look starts another").toBe("woke");
		expect(wakes, "the message was offered again").toEqual(["m1", "m1"]);
	});

	it("a wake that throws at once is not a wake", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-pwf-"));
		await writeMessage(root, "r", msg("m1"));
		const d = new PeerDelivery({ root, sessionId: "r", events: () => [], liveRun: () => undefined, onWake: () => { throw new Error("boom"); } });
		expect(d.poke()).toBe("waiting");
	});

	it("a spent chain at the head of the inbox does not stop another chain's message from waking", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-pwf-"));
		await writeMessage(root, "r", { ...msg("spent", "k/a#0"), at: 1 });
		await writeMessage(root, "r", { ...msg("fresh", "k/b#0"), at: 2 });
		const wakes: string[] = [];
		const d = new PeerDelivery({
			root, sessionId: "r", events: () => [], liveRun: () => undefined,
			onWake: (w) => void wakes.push(w.via.kind === "peer" ? w.via.messageId : "?"),
			mayWake: (rootId) => rootId !== "k/a#0",
		});
		expect(d.poke()).toBe("woke");
		expect(wakes).toEqual(["fresh"]);
	});
});
