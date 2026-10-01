/**
 * The service's typed refusals. A transport maps each to its own status
 * (409 / 409 / 503 in the two products that wrote these by hand); the
 * service itself knows no status code.
 */

/** A run is already in flight for this session — one run per session. */
export class InFlightError extends Error {
	readonly sessionId: string;
	readonly runId: string;
	constructor(sessionId: string, runId: string) {
		super(`session ${sessionId} already has a run in flight (${runId})`);
		this.name = "InFlightError";
		this.sessionId = sessionId;
		this.runId = runId;
	}
}

/** The log holds a run that never reached its terminal — a previous
 *  process died inside it. It must be resumed (recovery drives ONE run to
 *  its terminal) before a new turn starts; `run(..., { resumeFirst: true })`
 *  does that in one call. The one thing the service never does is resume
 *  silently. */
export class OpenRunError extends Error {
	readonly sessionId: string;
	readonly runId: string;
	constructor(sessionId: string, runId: string) {
		super(`session ${sessionId} still has an open run (${runId}) — resume it before starting a new turn`);
		this.name = "OpenRunError";
		this.sessionId = sessionId;
		this.runId = runId;
	}
}

/** The factory's agent writes to a different store than the service was
 *  given: a run settled and its terminal is not on the service's store.
 *  Two stores are two truths, which kiso does not allow — the session is
 *  refused from here on (the host's wiring is wrong, not the run). */
export class StoreMismatchError extends Error {
	readonly sessionId: string;
	readonly runId: string;
	constructor(sessionId: string, runId: string, expectedSeq: number) {
		super(`session ${sessionId}: run ${runId} settled at seq ${expectedSeq} but the service's store does not hold it — the agent factory's store is not the service's store`);
		this.name = "StoreMismatchError";
		this.sessionId = sessionId;
		this.runId = runId;
	}
}

/** drain() was called: no new run or resume starts in this process. */
export class DrainingError extends Error {
	constructor() {
		super("the service is draining — no new run starts in this process");
		this.name = "DrainingError";
	}
}

/** ADR-0057: a steer for a session with no run in flight. The host starts a
 *  run with the input instead. */
export class NotRunningError extends Error {
	readonly sessionId: string;
	constructor(sessionId: string) {
		super(`session ${sessionId} has no run in flight — start a run with this input`);
		this.name = "NotRunningError";
		this.sessionId = sessionId;
	}
}
