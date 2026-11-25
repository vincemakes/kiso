/**
 * writeMessage's `alive`: the host's word that the receiver still exists, asked right before the inbox is made. A receiver the
 * host has deleted is refused in words and no inbox is made; without the word, every receiver is taken as alive (unchanged).
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InboxRefusedError, writeMessage } from "../src/inbox.js";

const message = { messageId: "m1", from: "k/a", fromTitle: "A", text: "hi", files: [], rootId: "k/a#0", at: 1 };

describe("writeMessage and the receiver's existence", () => {
	it("a receiver the host calls gone is refused in words, and its inbox is never made", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-inbox-alive-"));
		await expect(writeMessage(root, "b", message, () => false)).rejects.toThrow(InboxRefusedError);
		await expect(writeMessage(root, "b", message, () => false)).rejects.toThrow(/no longer exists/);
		expect(existsSync(join(root, "b.inbox"))).toBe(false);
	});
	it("alive, or no word at all: written as before", async () => {
		const root = mkdtempSync(join(tmpdir(), "kiso-inbox-alive-"));
		await expect(writeMessage(root, "b", message, () => true)).resolves.toBe("written");
		await expect(writeMessage(root, "c", message)).resolves.toBe("written");
	});
});
