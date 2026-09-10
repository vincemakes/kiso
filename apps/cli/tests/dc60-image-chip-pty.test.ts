/**
 * DC-60 (0.32.2) — a sent turn that carries an image echoes its words.
 *
 * The owner's 0.32.1 dogfood: paste a screenshot, send — the user chip
 * showed a bar with nothing on it. The turn's durable content is an array
 * (text, image, text); the live echo passed only a string through and an
 * array became "". On a real PTY, with a png in the workdir named in the
 * prompt (REL-0152-D11's path route — the same content array the ctrl+v
 * capsule produces): the chip reads the words with the image marked.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isolatedEnv } from "../../../tests/helpers/isolated-cli.mjs";
import { fauxScript, ptyRun, spares } from "./helpers/pty.js";

// a 2×2 red PNG, built by hand: signature, IHDR, IDAT (stored deflate), IEND
function tinyPng(): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
	const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type, "ascii"); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
	const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 2;
	const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
	// zlib stored block: header 78 01, BFINAL+stored, LEN, NLEN, data, adler32
	const len = raw.length; const stored = Buffer.concat([Buffer.from([0x78, 0x01, 0x01, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff]), raw]);
	let a = 1, b = 0; for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; } const adler = Buffer.alloc(4); adler.writeUInt32BE(((b << 16) | a) >>> 0);
	return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.concat([stored, adler])), chunk("IEND", Buffer.alloc(0))]);
}

describe("DC-60 — the user chip of a turn that carries an image", () => {
	it("shows the words with the image marked, never an empty chip", () => {
		const { env } = isolatedEnv({
			KISO_FAUX_SCRIPT: fauxScript([{ events: [{ type: "text_delta", text: "A red square." }, { type: "stop", reason: "end_turn" }] }, ...spares(2)]),
			KISO_MODE: "bypass",
		});
		const workdir = mkdtempSync(join(tmpdir(), "kiso-dc60-"));
		writeFileSync(join(workdir, "shot.png"), tinyPng());
		const raw = ptyRun(["--mode", "bypass", "dc60"], env as NodeJS.ProcessEnv, {
			cwd: workdir,
			feeds: [
				["/ commands · ↑ history", "look at shot.png please\r"],
				["A red square.", "exit\r"],
			],
			timeout: 60,
		});
		const plain = raw.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, "");
		expect(plain, "the chip lost its words when an image rode the turn").toContain("look at (image) please");
	}, 120_000);
});
