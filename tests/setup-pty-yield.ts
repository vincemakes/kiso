/**
 * One macrotask between PTY tests, so the worker can answer the runner.
 *
 * vitest's worker talks to the main process over birpc, and
 * `onTaskUpdate` is a REQUEST — it waits for a reply, and that reply
 * arrives as a macrotask. `@vitest/runner` awaits only microtasks
 * between two tests (`setTimeout`/`setImmediate` appear zero times in
 * its dist), so a file of SYNCHRONOUS tests — `spawnSync` back to back,
 * which is exactly what this pool is — never turns the event loop from
 * the file's first test to its last. The first reply sits unread on the
 * message port, and once the file's synchronous total passes birpc's
 * DEFAULT_TIMEOUT the timer fires first.
 *
 * That timeout is 60_000 and it is HARD-CODED — `createBirpc` is called
 * without one (vitest 3.2.7, chunks/index.B521nVV-.js:3). There is no
 * option to raise, and no pool that avoids it: `forks` uses IPC and the
 * same birpc with the same 60s.
 *
 * The trigger is the FILE'S SYNCHRONOUS TOTAL, not any one test. On CI
 * it was `tui2-r3v2-safer-pty.test.ts`: four synchronous cases summing
 * to 78.5s, none longer than 40s, every test green — and vitest exited
 * 1 on an unhandled error with nothing wrong.
 *
 * Measured both ways on this repo's own vitest: a file of three
 * synchronous `execSync("sleep 25")` cases reports
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` with all three
 * green; the same file with this hook exits clean.
 *
 * RESIDUAL RISK, stated: a SINGLE synchronous scenario longer than 60s
 * would still cross it, because there is no yield inside one test. The
 * longest on CI today is 40s (tui-modes, budgeted 90s). If that day
 * comes, R3c's own wall assertion goes red beside this — two reds, not
 * a silent pass.
 */
import { afterEach } from "vitest";

afterEach(() => new Promise<void>((r) => setImmediate(r)));
