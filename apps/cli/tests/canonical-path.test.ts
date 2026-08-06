/**
 * 八 — the approval detail shows the CANONICAL path (the tools' own
 * resolution) and the FULL content — extracted from the tui package's
 * render-safety suite when the terminal layer was extracted (the
 * canonical resolver is the CLI's injection into the pure renderer).
 */

import { describe, expect, it } from "vitest";
import { renderEvent } from "@vincemakes/kiso-tui";
import { canonicalTargetPath } from "@vincemakes/kiso-tools-node";

describe("八: the approval detail's canonical path (CLI-injected)", () => {
	it("八: write_file approval shows the CANONICAL path and the FULL content", async () => {
		const { mkdtempSync, realpathSync, writeFileSync, symlinkSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "kiso-render-"))); // /var → /private/var
		const real = join(dir, "real.txt");
		writeFileSync(real, "actual-target", "utf8");
		symlinkSync(real, join(dir, "link.txt"));
		expect(canonicalTargetPath(join(dir, "link.txt"))).toBe(real);

		const longContent = "X".repeat(500);
		const rendered = renderEvent(
			{
				type: "permission_requested",
				name: "write_file",
				input: { path: join(dir, "link.txt"), content: longContent },
			},
			false,
			canonicalTargetPath,
		);
		// The canonical path is shown, and the ENTIRE content — no truncated
		// tail hiding a dangerous payload.
		expect(rendered.text).toContain(real);
		expect(rendered.text).toContain(longContent);
		expect(rendered.text).not.toContain("…");
	});
});
