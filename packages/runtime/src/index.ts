/**
 * The SDK surface — the curated root manifest (S1, 2026-08-12).
 *
 * Every name here is a review-approved contract: adding or removing one
 * WITHOUT the ritual (the review's sign-off + a public-surface.json
 * refresh) turns the public-surface gate red. See docs/sdk.md for the
 * contract, the aliases, and what deliberately lives behind the
 * first-party door.
 *
 * What is NOT here is not the SDK. The recovery / compose / summarize /
 * lock-adapter machinery and buildAdapter live behind "./internal"
 * (unstable, first-party only — see internal.ts).
 *
 * Canonical names: Agent = AgentRuntime, Session = AgentSession. The old
 * names are deprecated aliases, removed in the next major (additive,
 * ADR-0051 Amendment 1 — release rounds move the cli minor).
 */

// agent
export { AgentRuntime, AgentRuntime as Agent, createAgent } from "./agent.js";
export type { AgentDefinition, PermissionPolicy, PermissionRule } from "./agent.js";

// session
export { AgentSession, AgentSession as Session } from "./session.js";
export { PoisonedSessionError, ResumeBlockedError } from "./session.js";
export type { ApprovalRequest, CompactInfo, SessionConfig, SummarizeResult } from "./session.js";

// run
export { Run } from "./run.js";

// store
export { SessionStore, StaleWriterError, StoreCorruptionError } from "./store.js";
export type { Event, SessionMeta, StoreRecord } from "./store.js";

// extensions
export { disposeExtensions, loadExtensions, loadProjectExtensions } from "./extensions.js";
export type { KisoExtension } from "./extensions.js";

// ledger
export { executionForCallId, executionLedger } from "./ledger.js";
export type { ExecutionRecord, ExecutionStatus } from "./ledger.js";

// trust
export { kisoHome, projectArtifacts, recordTrust, trustFor } from "./trust.js";
export type { ProjectArtifact, ProjectArtifacts, TrustDecision, TrustRecord } from "./trust.js";

// usage — the canonical accounting schema (E2/1.3.0, R4b-1 ruling:
// additive minor, one function; the signature is frozen the moment this
// line lands — changing it is a MAJOR ritual). R5b-④a set the final
// shape at freeze time: the trailing `table?: PricingTable` injection
// slot defaults to the builtin v1 table, so the R5a-1-commercial table
// rides day one without ever widening this signature. Raw stays
// provider observation; canonicalizeUsage derives at the accounting
// boundary (R4 Case B — the frozen usage union does not move).
export { canonicalizeUsage } from "./usage/canonical.js";
