import type { ContentBlock, Event, MessageSource } from "@vincemakes/kiso-core";
import type { Agent, ApprovalRequest, Run, Session, SessionStore } from "@vincemakes/kiso-runtime";
import { openRunId } from "@vincemakes/kiso-runtime/internal";
import { DrainingError, InFlightError, NotRunningError, OpenRunError, StoreMismatchError } from "./errors.js";
import { executionDelta } from "./execution.js";
import { type Listener, tail } from "./tail.js";

/**
 * The hosted-session service — many durable sessions in one long-lived
 * process, each with observers, one run at a time.
 *
 * What it is: the layer two products wrote independently on top of the
 * runtime (a session registry, the one-run rule, a pump that fans a run's
 * events out to listeners and counts executing tools, replay-from-seq for
 * reconnecting observers, approve / abort / resume routed to the right
 * run, drain before exit). It names no product noun: the product hands
 * in an agent FACTORY (control inversion) and the service never learns
 * what the agent is for.
 *
 * What it is not: a transport. HTTP, SSE, sockets and their status codes
 * live above it. It is also not a second Agent — every session here is
 * `runtime.createAgent(...).session({ id })`, and every run is that
 * session's `run()` / `resume()`; the service adds bookkeeping, never a
 * loop of its own.
 */

export interface SessionServiceOptions {
	/** The store every session in this process lives on — the SAME one the
	 *  factory's agents write to. The service reads it for boot recovery
	 *  (`openRuns()`) and for cold reads of sessions it has not opened;
	 *  everything about an open session is read from that session's own
	 *  log, so the run that writes and the replay that reads share one
	 *  object by construction. The remaining way to get two stores — a
	 *  factory that binds its agents to another store — is DETECTED: the
	 *  first run to settle on such a session ends with StoreMismatchError
	 *  and the session is refused from then on.
	 *
	 *  Ownership: the host owns the store. `close()` aborts runs and
	 *  forgets sessions; it never closes the store — the host calls
	 *  `store.closeAll()` when its process ends. */
	readonly store: SessionStore;
	/** The product's agent factory, called once per session id (and again by
	 *  `reopen`). Everything product-specific — prompt, tools, extensions,
	 *  permission policy — is decided in here. */
	readonly open: (sessionId: string) => Promise<Agent>;
	readonly hooks?: {
		/** Product-level parking beyond the kernel's own approvals — the ask
		 *  extension's pending questions are the known case. A non-empty
		 *  list means the run is waiting for a person, so `abort()` refuses
		 *  (a voided draft is not what "stop" means when someone is being
		 *  asked) unless forced. */
		readonly parkedBy?: (sessionId: string) => readonly string[];
		/** After `abort()` has aborted a run: the product's cleanup, e.g.
		 *  finishing paid jobs the run left in flight. */
		readonly onAbort?: (sessionId: string, runId: string) => Promise<void> | void;
		/** After a run has settled — its terminal delivered to every
		 *  listener, the session idle again. The product's "what next": a
		 *  follow-up turn (`service.run`), a resume when the last uncertain
		 *  verdict is in (`uncertainRemaining === 0`), a notification. The
		 *  service itself never starts a run on its own. Runs after the
		 *  store check, so a mismatched session never reaches it. */
		readonly onSettled?: (settled: SettledRun) => Promise<void> | void;
	};
}

/** What `hooks.onSettled` receives. */
export interface SettledRun {
	readonly sessionId: string;
	readonly runId: string;
	/** The terminal's outcome kind: completed | aborted | error | max_turns | max_tokens | hook_stopped. */
	readonly outcome: string;
	/** Executions still awaiting a human verdict after this run. */
	readonly uncertainRemaining: number;
	/** The highest seq this run delivered. */
	readonly highWater: number;
	/** ADR-0057: input a steer handed this run that it never admitted — the
	 *  run sealed first. The host's "what next" is usually a new run with it. */
	readonly unadmitted: readonly (string | readonly ContentBlock[])[];
}

export interface RunHandle {
	readonly runId: string;
	/** Settles when the run has reached its terminal and the last event has
	 *  been delivered to every listener. Rejects only if the runtime threw
	 *  (a poisoned session); a run that fails still SETTLES — its failure is
	 *  a terminal event, not an exception. */
	readonly done: Promise<void>;
}

export interface RunOptions {
	readonly source?: MessageSource;
	/** The log holds an open run from a previous process: resume it to its
	 *  terminal first, then start this turn. Without this the call refuses
	 *  with `OpenRunError` — the service never resumes silently. */
	readonly resumeFirst?: boolean;
}

export type AbortOutcome =
	| { readonly kind: "idle" }
	| { readonly kind: "parked"; readonly runId: string; readonly approvals: readonly ApprovalRequest[]; readonly reasons: readonly string[] }
	| { readonly kind: "stopped"; readonly runId: string; readonly settled: Promise<void> };

export interface DrainReport {
	/** Sessions with a tool executing when drain began; waited for, up to the grace. */
	readonly waitedFor: readonly string[];
	/** Sessions whose run is waiting for a person — untouched, resumable. */
	readonly parked: readonly string[];
	/** Sessions streaming (no tool executing) — cut when the process exits, resumable. */
	readonly interrupted: readonly string[];
	/** The subset of `waitedFor` still executing when the grace ran out. */
	readonly timedOut: readonly string[];
}

export interface OpenRun {
	readonly sessionId: string;
	readonly runId: string;
}

interface Held {
	readonly id: string;
	agent: Agent;
	session: Session;
	readonly listeners: Set<Listener>;
	live: Run | null;
	pumping: Promise<void> | null;
	executing: number;
	highWater: number;
	/** Set once a settled run's terminal was not found on the service's store. */
	mismatch: StoreMismatchError | null;
	/** ADR-0057: what the latest run accepted and never admitted, keyed by its terminal. */
	unadmitted: { readonly runId: string; readonly terminalSeq: number; readonly items: readonly (string | readonly ContentBlock[])[] } | null;
}

export class SessionService {
	readonly #store: SessionStore;
	readonly #open: SessionServiceOptions["open"];
	readonly #hooks: NonNullable<SessionServiceOptions["hooks"]>;
	/** id → the opening (memoized, so two concurrent callers share one open). */
	readonly #opening = new Map<string, Promise<Held>>();
	/** id → the held session, once open. */
	readonly #held = new Map<string, Held>();
	#draining = false;

	constructor(options: SessionServiceOptions) {
		this.#store = options.store;
		this.#open = options.open;
		this.#hooks = options.hooks ?? {};
	}

	// ---- the registry -------------------------------------------------------

	async #hold(sessionId: string): Promise<Held> {
		const existing = this.#opening.get(sessionId);
		if (existing !== undefined) return existing;
		const opening = (async (): Promise<Held> => {
			const agent = await this.#open(sessionId);
			const session = await agent.session({ id: sessionId });
			const held: Held = { id: sessionId, agent, session, listeners: new Set(), live: null, pumping: null, executing: 0, highWater: -1, mismatch: null, unadmitted: null };
			this.#held.set(sessionId, held);
			return held;
		})();
		this.#opening.set(sessionId, opening);
		try {
			return await opening;
		} catch (err) {
			this.#opening.delete(sessionId);
			throw err;
		}
	}

	/** Rebuild an IDLE session from the factory — the product's definition
	 *  changed (its tool set, its prompt) and the next run should see it.
	 *  Observers are carried over. Refuses while a run is in flight. */
	async reopen(sessionId: string): Promise<void> {
		const held = await this.#hold(sessionId);
		if (held.live !== null) throw new InFlightError(sessionId, held.live.runId);
		const agent = await this.#open(sessionId);
		held.agent = agent;
		held.session = await agent.session({ id: sessionId });
	}

	// ---- runs -----------------------------------------------------------------

	#pump(held: Held, run: Run): RunHandle {
		held.live = run;
		const pumping = (async (): Promise<void> => {
			try {
				for await (const event of run) {
					// ADR-0057: the ingress sealed before the terminal was appended,
					// so what never landed is known by the time it is delivered.
					if (event.type === "terminal") held.unadmitted = { runId: run.runId, terminalSeq: event.seq, items: run.unadmitted() };
					held.executing = Math.max(0, held.executing + executionDelta(event));
					held.highWater = Math.max(held.highWater, event.seq);
					for (const listener of [...held.listeners]) {
						try {
							listener(event);
						} catch {
							held.listeners.delete(listener); // a throwing observer leaves; the run does not
						}
					}
				}
			} finally {
				if (held.live === run) {
					held.live = null;
					held.pumping = null;
					held.executing = 0;
				}
			}
			// the one-truth check: what this run wrote must be on the store the
			// service was given. Persist-first means the terminal is on disk
			// before it was yielded above; a store that does not hold it is a
			// different store.
			if (held.highWater >= 0 && !this.#store.load(held.id).some((r) => r.event.seq === held.highWater)) {
				held.mismatch = new StoreMismatchError(held.id, run.runId, held.highWater);
				throw held.mismatch;
			}
			if (this.#hooks.onSettled !== undefined) {
				const terminal = [...held.session.log.all].reverse().find((e) => e.type === "terminal");
				await this.#hooks.onSettled({
					sessionId: held.id,
					runId: run.runId,
					outcome: terminal !== undefined && terminal.type === "terminal" ? terminal.outcome.kind : "unknown",
					uncertainRemaining: held.session.uncertainExecutions().length,
					highWater: held.highWater,
					unadmitted: run.unadmitted(),
				});
			}
		})();
		held.pumping = pumping;
		void pumping.catch(() => {}); // a host that does not await `done` gets no unhandled rejection
		return { runId: run.runId, done: pumping };
	}

	/** ADR-0057 — hand the session's live run a person's input; it is
	 *  admitted at the run's next Safe Admission boundary. Refuses with
	 *  `NotRunningError` when no run is live, and with the runtime's
	 *  `RunClosedError` once the run's ingress has sealed — either way the
	 *  host starts a new run with the input. */
	steer(sessionId: string, input: string | readonly ContentBlock[]): { readonly runId: string } {
		const live = this.#held.get(sessionId)?.live ?? null;
		if (live === null) throw new NotRunningError(sessionId);
		live.steer(input);
		return { runId: live.runId };
	}

	/** ADR-0057 — what the run that ended at `terminalSeq` accepted and never
	 *  admitted; null when nothing, or when that is not the latest terminal. */
	unadmittedAt(sessionId: string, terminalSeq: number): { readonly runId: string; readonly items: readonly (string | readonly ContentBlock[])[] } | null {
		const u = this.#held.get(sessionId)?.unadmitted ?? null;
		return u !== null && u.terminalSeq === terminalSeq && u.items.length > 0 ? { runId: u.runId, items: u.items } : null;
	}

	/** Start a turn. Refuses with `InFlightError` (one run per session),
	 *  `OpenRunError` (a previous process died inside a run — see
	 *  `resumeFirst`) or `DrainingError`. */
	async run(sessionId: string, input: string | readonly ContentBlock[], options: RunOptions = {}): Promise<RunHandle> {
		if (this.#draining) throw new DrainingError();
		const held = await this.#hold(sessionId);
		if (held.mismatch !== null) throw held.mismatch;
		if (held.live !== null) throw new InFlightError(sessionId, held.live.runId);
		const open = openRunId(this.#store.load(sessionId));
		if (open !== undefined) {
			if (options.resumeFirst !== true) throw new OpenRunError(sessionId, open);
			await this.#pump(held, held.session.resume()).done;
		}
		const run = held.session.run(input, options.source !== undefined ? { source: options.source } : {});
		return this.#pump(held, run);
	}

	/** Drive the open run (one a previous process left, or one parked at an
	 *  approval that has since been answered) to its terminal. */
	async resume(sessionId: string): Promise<RunHandle> {
		if (this.#draining) throw new DrainingError();
		const held = await this.#hold(sessionId);
		if (held.mismatch !== null) throw held.mismatch;
		if (held.live !== null) throw new InFlightError(sessionId, held.live.runId);
		return this.#pump(held, held.session.resume());
	}

	/** Stop the run in flight. A run waiting for a person (a kernel approval,
	 *  or whatever `hooks.parkedBy` names) is PARKED, not running: aborting
	 *  it would void the draft the answer is meant to continue, so the
	 *  service refuses and says who is being waited for — `force` overrides.
	 *  "stopped" means the abort was delivered; `settled` resolves when the
	 *  run's terminal is written (a tool that ignores the abort signal keeps
	 *  the run open until it returns — the kernel does not kill tools). The
	 *  `onAbort` hook runs on the abort, not on the settle. */
	async abort(sessionId: string, options: { readonly force?: boolean } = {}): Promise<AbortOutcome> {
		const held = await this.#hold(sessionId);
		const run = held.live;
		if (run === null) return { kind: "idle" };
		const approvals = held.session.pendingApprovals();
		const reasons = this.#hooks.parkedBy?.(sessionId) ?? [];
		if ((approvals.length > 0 || reasons.length > 0) && options.force !== true) {
			return { kind: "parked", runId: run.runId, approvals, reasons };
		}
		run.abort();
		const settled = held.pumping?.catch(() => {}) ?? Promise.resolve();
		await this.#hooks.onAbort?.(sessionId, run.runId);
		return { kind: "stopped", runId: run.runId, settled };
	}

	// ---- decisions ------------------------------------------------------------

	/** Answer a kernel approval. `needsResume` is true when no run was live
	 *  to consume the answer (the process that asked is gone): the decision
	 *  is durable, and `resume()` is what makes the run continue. */
	async approve(sessionId: string, decisionId: string, allow: boolean, reason?: string): Promise<{ readonly needsResume: boolean }> {
		const held = await this.#hold(sessionId);
		const wasLive = held.live !== null;
		await held.session.approve(decisionId, allow, reason);
		return { needsResume: !wasLive };
	}

	async pendingApprovals(sessionId: string): Promise<readonly ApprovalRequest[]> {
		return (await this.#hold(sessionId)).session.pendingApprovals();
	}

	async uncertainExecutions(sessionId: string): Promise<ReturnType<Session["uncertainExecutions"]>> {
		return (await this.#hold(sessionId)).session.uncertainExecutions();
	}

	/** Record a verdict on an uncertain execution. `remaining` is how many
	 *  still await one; the host resumes when it reaches zero — the service
	 *  does not start runs on its own. */
	async resolveUncertain(sessionId: string, executionId: string, resolution: "rerun" | "abandoned"): Promise<{ readonly remaining: number }> {
		const held = await this.#hold(sessionId);
		await held.session.resolveUncertain(executionId, resolution);
		return { remaining: held.session.uncertainExecutions().length };
	}

	// ---- observation ----------------------------------------------------------

	/** Every event after `after` — the ones on disk now, then the live ones
	 *  as they land — exactly once each, in order. Returns the unsubscribe.
	 *  The replay reads the OPEN session's own log, never a second copy. */
	async subscribe(sessionId: string, after: number, listener: Listener): Promise<() => void> {
		const held = await this.#hold(sessionId);
		return tail(() => held.session.log.all.filter((e) => e.seq > after), held.listeners, after, listener);
	}

	/** The durable log after `after`. An open session answers from its own
	 *  log; a session this process has not opened is read from the store
	 *  (a cold read, nothing opened). */
	events(sessionId: string, after = -1): Event[] {
		const held = this.#held.get(sessionId);
		const events = held !== undefined ? held.session.log.all : this.#store.load(sessionId).map((r) => r.event);
		return events.filter((e) => e.seq > after);
	}

	isRunning(sessionId: string): boolean {
		return this.#held.get(sessionId)?.live !== null && this.#held.get(sessionId)?.live !== undefined;
	}

	/** The highest seq this process has delivered for the session, −1 before any. */
	highWater(sessionId: string): number {
		return this.#held.get(sessionId)?.highWater ?? -1;
	}

	executingCount(): number {
		let n = 0;
		for (const held of this.#held.values()) n += held.executing;
		return n;
	}

	get draining(): boolean {
		return this.#draining;
	}

	/** The run a previous process left without a terminal on this session,
	 *  or null. The plain read the transport's snapshot needs. */
	openRun(sessionId: string): string | null {
		return openRunId(this.#store.load(sessionId)) ?? null;
	}

	/** True once a settled run proved the factory's store is not this one. */
	mismatched(sessionId: string): boolean {
		return this.#held.get(sessionId)?.mismatch !== null && this.#held.get(sessionId)?.mismatch !== undefined;
	}

	/** Boot recovery: every session on the store whose last run has no
	 *  terminal. The host decides what to do with them (resume, or leave
	 *  for the next request to find). */
	openRuns(): OpenRun[] {
		const out: OpenRun[] = [];
		for (const sessionId of this.#store.ids()) {
			const runId = openRunId(this.#store.load(sessionId));
			if (runId !== undefined) out.push({ sessionId, runId });
		}
		return out;
	}

	// ---- process lifecycle -------------------------------------------------

	/** Stop accepting runs; wait up to `graceMs` for executing tools; report.
	 *  Nothing is aborted here — a run cut by the process exiting is
	 *  resumable, and the report says which sessions those are. */
	async drain(graceMs: number): Promise<DrainReport> {
		this.#draining = true;
		const waitedFor: string[] = [];
		const parked: string[] = [];
		const interrupted: string[] = [];
		const waits: Promise<void>[] = [];
		for (const held of this.#held.values()) {
			if (held.live === null) continue;
			if (held.executing > 0) {
				waitedFor.push(held.id);
				if (held.pumping !== null) waits.push(held.pumping.catch(() => {}));
				continue;
			}
			const askedFor = held.session.pendingApprovals().length > 0 || (this.#hooks.parkedBy?.(held.id) ?? []).length > 0;
			(askedFor ? parked : interrupted).push(held.id);
		}
		if (waits.length === 0) return { waitedFor, parked, interrupted, timedOut: [] };
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), graceMs);
		});
		const outcome = await Promise.race([Promise.allSettled(waits).then(() => "done" as const), deadline]);
		if (timer !== undefined) clearTimeout(timer);
		const timedOut = outcome === "timeout" ? waitedFor.filter((id) => (this.#held.get(id)?.executing ?? 0) > 0) : [];
		return { waitedFor, parked, interrupted, timedOut };
	}

	/** Abort every live run, wait up to `graceMs` for each to settle (a
	 *  tool that ignores the abort keeps its run open until it returns),
	 *  then forget every session. Whatever did not settle is resumable by
	 *  the next process — persist-first means nothing delivered is lost.
	 *  The STORE is not closed here: the host owns it and calls
	 *  `store.closeAll()` when its process ends. */
	async close(graceMs = 0): Promise<void> {
		this.#draining = true;
		const settling: Promise<void>[] = [];
		for (const held of this.#held.values()) {
			held.live?.abort();
			if (held.pumping !== null) settling.push(held.pumping.catch(() => {}));
		}
		if (settling.length > 0 && graceMs > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([Promise.all(settling), new Promise<void>((resolve) => {
				timer = setTimeout(resolve, graceMs);
			})]);
			if (timer !== undefined) clearTimeout(timer);
		}
		this.#held.clear();
		this.#opening.clear();
	}
}

export function createSessionService(options: SessionServiceOptions): SessionService {
	return new SessionService(options);
}
