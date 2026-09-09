/**
 * "There is a newer kiso."
 *
 * The owner's ruling on the opening (2026-09-02): no logo, the name is
 * the mark (§7.10 stands), and the banner may gain AT MOST one line
 * saying a new version exists. This is that one line's machinery, and
 * almost all of it is about the things it must not do.
 *
 * IT IS kiso's ONLY OUTBOUND REQUEST. Everything else kiso sends goes to
 * the model endpoint the human configured. This one goes to the public
 * npm registry, carries no identity, no usage and no session data — a
 * GET of one dist-tags document — and can be switched off entirely with
 * `KISO_NO_UPDATE_CHECK=1`. That is a real change in what the product
 * is, which is why it is stated here rather than buried.
 *
 * WHAT IT MUST NEVER DO:
 *
 *   - block the first frame. The check is fired and forgotten; the
 *     opening is drawn from local facts and never waits.
 *   - say anything when it fails. No network, a proxy, a 500, a
 *     malformed body, a timeout — all of them are silence. A version
 *     check that interrupts you to report that it could not check is
 *     worse than no version check.
 *   - run where it cannot be wanted: a faux session (the test and demo
 *     path), a non-TTY (a pipe has no banner to append to), or an
 *     explicit opt-out.
 *   - ask twice in a day, or nag about a version it has already
 *     mentioned. Both are remembered in the cache file.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The dist-tags document — the smallest thing the registry will tell us
 *  that answers the question. The full packument is megabytes. */
const ENDPOINT = "https://registry.npmjs.org/-/package/@vincemakes/kiso-code/dist-tags";
const TIMEOUT_MS = 1_500;
const EVERY_MS = 24 * 60 * 60 * 1_000;

/** The registry, redirectable for tests ONLY. A stub server's URL goes
 *  here so the suite can drive every branch — a slow answer, no answer,
 *  a malformed body — without reaching the network. Never documented for
 *  users: it is not a setting, it is a seam. */
const endpoint = (): string => process.env.KISO_UPDATE_ENDPOINT ?? ENDPOINT;

export interface UpdateCache {
	/** epoch ms of the last COMPLETED check, successful or not */
	readonly checkedAt: number;
	/** the latest version the registry reported, if the check succeeded */
	readonly latest?: string;
}

const cachePath = (kisoHome: string): string => join(kisoHome, "update-check.json");

function readCache(kisoHome: string): UpdateCache | null {
	try {
		const raw: unknown = JSON.parse(readFileSync(cachePath(kisoHome), "utf8"));
		if (raw === null || typeof raw !== "object") return null;
		const c = raw as Record<string, unknown>;
		if (typeof c.checkedAt !== "number") return null;
		return {
			checkedAt: c.checkedAt,
			...(typeof c.latest === "string" ? { latest: c.latest } : {}),
		};
	} catch {
		// a missing, unreadable or corrupt cache is simply no cache
		return null;
	}
}

function writeCache(kisoHome: string, c: UpdateCache): void {
	try {
		mkdirSync(dirname(cachePath(kisoHome)), { recursive: true });
		writeFileSync(cachePath(kisoHome), `${JSON.stringify(c)}\n`, "utf8");
	} catch {
		// an unwritable home means we check again next time — the only
		// cost is a request, and there is nothing here worth a message.
	}
}

/**
 * Semver-ish "is b newer than a", for the shapes this line ever sees:
 * three numeric parts, optionally a prerelease we treat as older. A
 * version we cannot parse is never "newer" — the failure direction is
 * silence, here as everywhere else in this file.
 */
export function isNewer(current: string, latest: string): boolean {
	const parse = (v: string): number[] | null => {
		const m = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim());
		return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])];
	};
	const a = parse(current);
	const b = parse(latest);
	if (a === null || b === null) return false;
	// a prerelease of the same numbers is not newer
	if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return false;
	for (let i = 0; i < 3; i += 1) {
		if (b[i]! > a[i]!) return true;
		if (b[i]! < a[i]!) return false;
	}
	return false;
}

/** The one line, when there is one. Words only — a human can read it,
 *  paste it, and nothing about it needs colour to be understood (§1.2). */
export const CHANGELOG_URL = "https://github.com/vincemakes/kiso/releases";
/** OR-9 (owner, 2026-09-09): the card under the banner, as WORDS — a
 *  title, the version with the command that installs it, the changelog.
 *  The CLI styles them at composition; nothing here needs colour. */
export function updateCardLines(latest: string): readonly string[] {
	return ["Update available", `New version ${latest} is available. Run kiso update`, `Changelog: ${CHANGELOG_URL}`];
}
/** OR-9: what the cache already knows, with NO request — the boot paints
 *  it under the banner before any check runs. Same silences as the check
 *  (opt-out, faux without a seam, a pipe); a merely-recent cache speaks. */
export function knownUpdate(deps: UpdateCheckDeps): string | null {
	const why = reasonNotToCheck(deps);
	if (why !== null && why !== "recent") return null;
	const cached = readCache(deps.kisoHome);
	return cached?.latest !== undefined && isNewer(deps.version, cached.latest) ? cached.latest : null;
}

export interface UpdateCheckDeps {
	readonly kisoHome: string;
	readonly version: string;
	readonly isTTY: boolean;
	readonly faux: boolean;
	readonly now?: number;
}

/**
 * Should this launch even ask? Pure, so the reasons are testable without
 * a network, a clock or a terminal.
 */
export function shouldCheck(deps: UpdateCheckDeps): boolean {
	return reasonNotToCheck(deps) === null;
}

/**
 * WHY a launch does not ask — and the distinction matters, because only
 * ONE of these reasons permits the line to be shown from cache.
 *
 * "recent" means the request is redundant; the human is still someone
 * who wants to be told. The other three mean the LINE is unwanted: an
 * opt-out is an answer about the feature, a faux session is a test or a
 * demo, and a pipe has no banner — worse, an inactive Body writes a
 * notice straight to stdout, so showing it there would put a row of
 * kiso's own prose into piped bytes and break pipe identity.
 */
function reasonNotToCheck({ kisoHome, isTTY, faux, now = Date.now() }: UpdateCheckDeps): "opt-out" | "faux" | "not-a-tty" | "recent" | null {
	if (process.env.KISO_NO_UPDATE_CHECK === "1") return "opt-out";
	// A faux session is the test and demo path, and the rule it exists for
	// is "never reaches the network". The redirect below is a TEST SEAM
	// pointing at a local stub — where it is set there is no network to
	// reach, and refusing anyway would make the one behaviour worth
	// showing on a screen unobservable. In production nothing sets it, so
	// a faux session still never asks.
	if (faux && process.env.KISO_UPDATE_ENDPOINT === undefined) return "faux";
	if (!isTTY) return "not-a-tty"; // and never writes a line into a pipe
	const cached = readCache(kisoHome);
	if (cached !== null && now - cached.checkedAt < EVERY_MS) return "recent";
	return null;
}

/**
 * The check itself: fire, forget, and resolve to the line to show or
 * null. NEVER throws, never rejects, never blocks a caller who does not
 * await it.
 */
export async function checkForUpdate(deps: UpdateCheckDeps): Promise<string | null> {
	const { kisoHome, version, now = Date.now() } = deps;
	const why = reasonNotToCheck(deps);
	// ONLY a recent check may still speak from cache. The other three
	// reasons are about the CARD, not the request, so the cache is no way
	// around them. OR-9: no `told` gate — a newer version is known at
	// EVERY start (the card is shown every start; the once-only rule of
	// §7.10 is superseded by the owner's 2026-09-09 ruling), only the
	// REQUEST stays at most once a day.
	if (why !== null) return why === "recent" ? knownUpdate(deps) : null;
	let latest: string | undefined;
	try {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
		try {
			const res = await fetch(endpoint(), { signal: ctl.signal, headers: { accept: "application/json" } });
			if (res.ok) {
				const body: unknown = await res.json();
				const tag = (body as Record<string, unknown> | null)?.latest;
				if (typeof tag === "string" && tag !== "") latest = tag;
			}
		} finally {
			clearTimeout(timer);
		}
	} catch {
		// every failure is silence — see the header
	}
	writeCache(kisoHome, { checkedAt: now, ...(latest === undefined ? {} : { latest }) });
	return latest !== undefined && isNewer(version, latest) ? latest : null;
}
