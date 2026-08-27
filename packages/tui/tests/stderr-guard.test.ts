/**
 * REL-0152-D17 — the compositor owns BOTH descriptors, or it owns
 * neither.
 *
 * REL-0152-R1 made the renderer hold the screen and write only the rows
 * that differ, and guarded stdout so that anything written outside a
 * frame forgets the screen. It guarded ONE descriptor.
 *
 * kiso writes to the other one. `console.error` goes to fd 2 — the same
 * tty — and several of those lines begin with `[` and contain `]`:
 *
 *   [extensions] ...
 *   [project .kiso] ...
 *   [KISO_FAUX_SCRIPT] cannot load ...
 *   [run failed] ...
 *
 * A held-screen renderer that does not know such a line was printed
 * skips exactly the rows it should repair. The residue therefore
 * survives on the rows whose desired content NEVER changes — the
 * composer box's `\u2500──╮` and `\u2500──╯` — which is where the owner sees a
 * stray `[` at the left edge and `]` at the right, for the whole
 * session, clearing only on a resize (the one full repaint) and coming
 * back on the next launch.
 *
 * The fix is not to silence the loggers. It is that the compositor
 * cannot hold a belief about a terminal it does not own: any write it
 * did not make forgets the screen, whichever descriptor carried it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Body } from "../src/compositor.js";

const H = 24;

function docked(): { body: Body; writes: string[] } {
	const writes: string[] = [];
	const body = new Body({ active: () => true, height: () => H, width: () => 80, editCol: () => 1 });
	// no `write` option: the guard only installs when the compositor owns
	// the real descriptors, which is the situation under test
	const realOut = process.stdout.write.bind(process.stdout);
	const realErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((c: string) => { writes.push(String(c)); return true; }) as typeof process.stdout.write;
	process.stderr.write = ((c: string) => { writes.push(String(c)); return true; }) as typeof process.stderr.write;
	(body as unknown as { __restore: () => void }).__restore = (): void => {
		process.stdout.write = realOut;
		process.stderr.write = realErr;
	};
	return { body, writes };
}

beforeEach(() => {
	vi.useFakeTimers();
	Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
	Object.defineProperty(process.stdout, "rows", { value: H, configurable: true });
	Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});
afterEach(() => {
	vi.useRealTimers();
	delete (process.stdout as { isTTY?: boolean }).isTTY;
});

describe("REL-0152-D17 — a write on EITHER descriptor forgets the screen", () => {
	it("a stderr write makes the next frame repaint the chrome it would have skipped", () => {
		const { body, writes } = docked();
		try {
			body.enter();
			body.raw(["a line"]);
			vi.advanceTimersByTime(50);
			writes.length = 0;
			// nothing changed in the model — the next frame writes nothing
			body.redraw();
			vi.advanceTimersByTime(50);
			const quiet = writes.join("");
			writes.length = 0;

			// …now something else prints to the terminal, on fd 2
			process.stderr.write("[extensions] a degraded path said something\n");
			writes.length = 0;
			body.redraw();
			vi.advanceTimersByTime(50);
			const after = writes.join("");

			expect(quiet, "a quiet frame should not repaint the box").not.toContain("\u2500");
			expect(after, "the frame after a stderr write must repaint the box").toContain("\u2500");
			expect(after, "…and the status row with it").toContain("/ commands");
		} finally {
			(body as unknown as { __restore: () => void }).__restore();
			body.exit();
		}
	});

	it("a stdout write outside a frame does the same — the R1 guard, still true", () => {
		const { body, writes } = docked();
		try {
			body.enter();
			body.raw(["a line"]);
			vi.advanceTimersByTime(50);
			process.stdout.write("something else entirely\n");
			writes.length = 0;
			body.redraw();
			vi.advanceTimersByTime(50);
			expect(writes.join("")).toContain("\u2500");
		} finally {
			(body as unknown as { __restore: () => void }).__restore();
			body.exit();
		}
	});
});
