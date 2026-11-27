/**
 * ADR-0064 — the work ledger: the one writer API over a work log. Every
 * mutator reduces the log with its candidate event first and refuses what the
 * reducer would report as a problem, so the rules live in one place
 * (reducer.ts), then appends against the revision it decided on.
 */
import { randomUUID } from "node:crypto";
import type { Event } from "@vincemakes/kiso-core";
import { verifyUserQuote } from "./acceptance.js";
import { actionDigest, effectResolutions } from "./effects.js";
import { WORK_LOG_FORMAT, type WorkEvent, type WorkEvidence, type WorkQuote } from "./events.js";
import type { AppendLog, AppendLogBackend } from "./log.js";
import { reduceWork, type Commitment, type Problem } from "./reducer.js";

export class WorkRefusedError extends Error {
	constructor(readonly rule: string) {
		super(`work refused: ${rule}`);
		this.name = "WorkRefusedError";
	}
}

/** Where a work lives in a backend: `<actorId>/work/<workId>`. */
export const workLogId = (actorId: string, workId: string): string => `${actorId}/work/${workId}`;

export class WorkLedger {
	private constructor(readonly log: AppendLog<WorkEvent>) {}

	static async create(backend: AppendLogBackend<WorkEvent>, input: { readonly actorId: string; readonly objective: string; readonly workId?: string }): Promise<WorkLedger> {
		const workId = input.workId ?? randomUUID();
		const log = await backend.writer(workLogId(input.actorId, workId));
		if (log.revision !== -1) {
			await log.close();
			throw new WorkRefusedError(`work ${workId} already exists`);
		}
		const ledger = new WorkLedger(log);
		await ledger.#append({ type: "work_created", format: WORK_LOG_FORMAT, workId, actorId: input.actorId, objective: input.objective });
		return ledger;
	}

	static async open(backend: AppendLogBackend<WorkEvent>, actorId: string, workId: string): Promise<WorkLedger> {
		const log = await backend.writer(workLogId(actorId, workId));
		const ledger = new WorkLedger(log);
		try {
			ledger.view();
		} catch (error) {
			await log.close();
			throw error;
		}
		return ledger;
	}

	view(): { readonly commitment: Commitment; readonly problems: readonly Problem[] } {
		return reduceWork(this.log.lines());
	}

	async #append(event: WorkEvent): Promise<number> {
		const revision = this.log.revision;
		const candidate = [...this.log.lines(), { seq: revision + 1, ts: 0, event }];
		const rule = reduceWork(candidate).problems.find((p) => p.seq === revision + 1);
		if (rule !== undefined) throw new WorkRefusedError(rule.rule);
		return this.log.append(revision, event);
	}

	addAcceptance(input: { readonly text: string; readonly authority: "agent" | "system"; readonly required: boolean; readonly supersedes?: readonly string[]; readonly criterionId?: string }): Promise<number> {
		const { criterionId = randomUUID(), ...rest } = input;
		return this.#append({ type: "acceptance_added", criterionId, ...rest });
	}

	/** A user criterion: refused, never downgraded, when the quote fails the provenance check. */
	addUserAcceptance(input: {
		readonly text: string;
		readonly quote: WorkQuote;
		readonly sessionEvents: readonly Event[];
		readonly required: boolean;
		readonly supersedes?: readonly string[];
		readonly criterionId?: string;
	}): Promise<number> {
		const quote = verifyUserQuote(input.sessionEvents, input.quote);
		if (quote === null) return Promise.reject(new WorkRefusedError("the quote is not in the human-authored surface of that seq"));
		const { criterionId = randomUUID(), sessionEvents: _events, quote: _candidate, ...rest } = input;
		return this.#append({ type: "acceptance_added", criterionId, authority: "user", quote, ...rest });
	}

	addEvidence(input: { readonly criterionIds: readonly string[]; readonly ref: WorkEvidence; readonly note?: string; readonly evidenceId?: string }): Promise<number> {
		const { evidenceId = randomUUID(), ...rest } = input;
		return this.#append({ type: "evidence_added", evidenceId, ...rest });
	}

	/** Bind the effect's identity to what it was decided on: this work, this revision, this action. */
	async prepareEffect(input: { readonly action: unknown; readonly label: string; readonly approvalId?: string; readonly effectId?: string }): Promise<string> {
		const effectId = input.effectId ?? randomUUID();
		const { commitment } = this.view();
		await this.#append({
			type: "effect_prepared",
			effectId,
			workId: commitment.id,
			actionDigest: actionDigest(input.action),
			workRevision: commitment.revision,
			label: input.label,
			...(input.approvalId !== undefined ? { approvalId: input.approvalId } : {}),
		});
		return effectId;
	}

	/** The write-ahead: resolves only once the dispatch is durable; the effect may begin after it. */
	dispatchEffect(effectId: string, execution?: { readonly sessionId: string; readonly executionId: string }): Promise<number> {
		const fx = this.view().commitment.effects.find((e) => e.effectId === effectId);
		return this.#append({ type: "effect_dispatching", effectId, attempt: fx?.attempt ?? 1, ...(execution ? { execution } : {}) });
	}

	resolveEffect(effectId: string, outcome: "succeeded" | "failed" | "rerun" | "abandoned", by: "human" | "host", receipt?: string): Promise<number> {
		const fx = this.view().commitment.effects.find((e) => e.effectId === effectId);
		return this.#append({ type: "effect_resolved", effectId, attempt: fx?.attempt ?? 1, outcome, by, ...(receipt !== undefined ? { receipt } : {}) });
	}

	/** Append what one session's execution ledger proves about this work's uncertain effects. */
	async reconcileEffects(sessionId: string, sessionEvents: readonly Event[]): Promise<number> {
		const resolutions = effectResolutions(this.view().commitment, sessionId, sessionEvents);
		for (const r of resolutions) await this.#append(r);
		return resolutions.length;
	}

	setState(to: "active" | "waiting" | "needs-human" | "verifying", reason: string): Promise<number> {
		return this.#append({ type: "state_changed", to, reason });
	}

	complete(summary?: string): Promise<number> {
		return this.#append({ type: "completed", ...(summary !== undefined ? { summary } : {}) });
	}

	fail(reason: string): Promise<number> {
		return this.#append({ type: "failed", reason });
	}

	cancel(reason: string): Promise<number> {
		return this.#append({ type: "cancelled", reason });
	}

	close(): Promise<void> {
		return this.log.close();
	}
}
