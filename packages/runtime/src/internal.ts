/**
 * The FIRST-PARTY door — NOT part of the public SDK contract (S1,
 * 2026-08-12, adjudicated).
 *
 * Unstable: anything here can move or vanish in any release without a
 * major bump. External consumers must import the curated root
 * (index.ts); this file exists for the in-repo consumers (apps/cli,
 * extensions, tests) that need machinery the SDK deliberately does not
 * expose — the recovery / compose / summarize / lock-adapter internals
 * and buildAdapter.
 *
 * This is today's pre-S1 index.ts verbatim: removing the door would be a
 * breaking change for the first-party consumers mid-migration.
 */
export * from "./agent.js";
export * from "./session.js";
export * from "./run.js";
export * from "./recovery.js";
export * from "./compose.js";
export * from "./summarize.js";
export * from "./store.js";
export * from "./lock-adapter.js";
export * from "./ledger.js";
export * from "./extensions.js";
export * from "./trust.js";
