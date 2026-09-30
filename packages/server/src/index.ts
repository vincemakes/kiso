/**
 * @vincemakes/kiso-server — the hosted-session service.
 *
 * Many durable sessions in one process; observers with exact replay from
 * a sequence number; approve / abort / resume routed to the right run;
 * drain and close. No transport, no product noun: the product supplies
 * the agent factory, and every run is the runtime's own `Session.run()`.
 */

export { createSessionService, SessionService } from "./service.js";
export type { AbortOutcome, DrainReport, OpenRun, RunHandle, RunOptions, SessionServiceOptions, SettledRun } from "./service.js";
export { DrainingError, InFlightError, NotRunningError, OpenRunError, StoreMismatchError } from "./errors.js";
export { EXECUTION_ENDED, executionDelta } from "./execution.js";
export { tail } from "./tail.js";
export { MAX_ARG_DEPTH, MAX_ARG_VALUE_CHARS, STRIPPED_ARG_KEYS, sanitizeToolArgs, toWireEvent } from "./wire.js";
export type { ProjectionOptions } from "./wire.js";
export type { Listener } from "./tail.js";
