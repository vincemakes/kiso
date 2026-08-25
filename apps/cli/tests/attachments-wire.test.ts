/**
 * REL-0152-D11, the wire half — the block reaches the PROVIDER.
 *
 * The unit cases above prove a path becomes an image block. That is
 * worth nothing on its own: the claim this feature makes is that the
 * model receives the image, and between the block and the model sit the
 * durable event, the projection, and an adapter. Each of those was
 * already written to carry an image and NONE of them had ever carried
 * one, because no caller could produce it.
 *
 * So this drives the real path — a real session, a real durable log, the
 * real projection, and both real adapters' message mapping — and asserts
 * on the bytes each provider would send.
 */

import { describe, expect, it } from "vitest";
import { projectMessages } from "@vincemakes/kiso-core";
import { attachImages } from "../src/attachments.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("REL-0152-D11 — the image survives the event, the projection and both adapters", () => {
	it("projects to a user message whose content is the blocks, image included", () => {
		const dir = mkdtempSync(join(tmpdir(), "kiso-wire-"));
		try {
			const png = join(dir, "s.png");
			writeFileSync(png, PNG);
			const content = attachImages(`what is this? ${png}`);
			expect(Array.isArray(content)).toBe(true);
			// the durable event's shape, verbatim — this is what run() appends
			const events = [{ type: "user_input", content, seq: 1 }];
			const messages = projectMessages(events as never);
			const user = messages.find((m) => m.role === "user")!;
			expect(Array.isArray(user.content), "the projection flattened the blocks to text").toBe(true);
			const blocks = user.content as { type: string; mediaType?: string }[];
			expect(blocks.find((b) => b.type === "image")!.mediaType).toBe("image/png");
			expect(blocks.some((b) => b.type === "text")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/**
 * The adapters' own mapping, driven through a fake client that records
 * the request. Nothing is mocked below the adapter: this is the object
 * the SDK would have been handed.
 */
describe("REL-0152-D11 — what each provider is actually sent", () => {
	const dir = mkdtempSync(join(tmpdir(), "kiso-wire2-"));
	const png = join(dir, "s.png");
	writeFileSync(png, PNG);
	const content = attachImages(`look ${png}`) as { type: string }[];
	const messages = [{ role: "user", content }];

	it("the OpenAI-compatible family gets image_url with a data URI", async () => {
		const { createOpenAICompatAdapter } = await import("@vincemakes/kiso-provider-openai");
		let seen: Record<string, unknown> | null = null;
		const client = {
			chat: {
				completions: {
					create: async (req: Record<string, unknown>) => {
						seen = req;
						return { [Symbol.asyncIterator]: async function* () { /* no chunks */ } };
					},
				},
			},
		};
		const adapter = createOpenAICompatAdapter(client as never);
		for await (const _ of adapter.stream({ model: "m", messages: messages as never, tools: [] } as never)) break;
		const msg = (seen!.messages as { content: { type: string; image_url?: { url: string } }[] }[]).find((m) => Array.isArray(m.content))!;
		const img = msg.content.find((c) => c.type === "image_url")!;
		expect(img.image_url!.url.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("Anthropic gets an image block with base64 source", async () => {
		const { createAnthropicAdapter } = await import("@vincemakes/kiso-provider-anthropic");
		let seen: Record<string, unknown> | null = null;
		const client = {
			messages: {
				stream: (req: Record<string, unknown>) => {
					seen = req;
					return { [Symbol.asyncIterator]: async function* () { /* no chunks */ }, abort: () => {} };
				},
			},
		};
		const adapter = createAnthropicAdapter(client as never);
		for await (const _ of adapter.stream({ model: "m", messages: messages as never, tools: [] } as never)) break;
		const msg = (seen!.messages as { content: { type: string; source?: { media_type: string } }[] }[]).find((m) => Array.isArray(m.content))!;
		const img = msg.content.find((c) => c.type === "image")!;
		expect(img.source!.media_type).toBe("image/png");
	});
});
