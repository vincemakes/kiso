/**
 * 0.40.6 — the choices kiso remembers for you, in
 * `<KISO_HOME>/preferences.json`.
 *
 * `config.json` is the human's file: kiso reads it and never writes it. A
 * choice made with a key — ctrl+t's thinking display, and (B1) the effort
 * last picked for each profile — has to survive a restart, so it lands here instead: kiso-owned, private
 * (0600, tmp + rename), and read back at start-up. A missing or unreadable
 * file is an empty one; an unknown value is ignored rather than guessed.
 *
 * Nothing is read until the CLI's startup names the file
 * (`usePreferences`) — the same rule as learned-windows.ts, so in-process
 * tests never read a home directory.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lookupModelMetadata, resolveReasoning, type ReasoningSetting } from "@vincemakes/kiso-runtime/internal";
import type { ModelProfile } from "./config.js";
import { kisoHome } from "./state.js";

export interface Preferences {
	/** ctrl+t: the thinking blocks as one italic line each. Absent = shown. */
	readonly thinking?: "shown" | "hidden";
	/** B1: the effort last picked for each profile (`/model <p> <e>`, or the
	 *  panel with a level) — where a NEW session of that profile starts. */
	readonly effort?: Readonly<Record<string, string>>;
}

let prefs: Preferences | null = null;
let prefsPath: string | null = null;

export function preferencesPath(home: string = kisoHome()): string {
	return join(home, "preferences.json");
}

function read(path: string): Preferences {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as { thinking?: unknown; effort?: unknown };
		const out: { thinking?: "shown" | "hidden"; effort?: Record<string, string> } = {};
		if (raw.thinking === "shown" || raw.thinking === "hidden") out.thinking = raw.thinking;
		if (raw.effort !== null && typeof raw.effort === "object" && !Array.isArray(raw.effort)) {
			const effort = Object.fromEntries(Object.entries(raw.effort as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
			if (Object.keys(effort).length > 0) out.effort = effort;
		}
		return out;
	} catch {
		return {};
	}
}

/** Startup: read the file, and keep choices made from here on in it. */
export function usePreferences(path: string = preferencesPath()): void {
	prefsPath = path;
	prefs = read(path);
}

/** The remembered choices; empty before startup names the file. */
export function preferences(): Preferences {
	return prefs ?? {};
}

/** Remember a choice. Returns false when no file was named. The file is
 *  re-read before the write, so another process's choice is kept. */
export function setPreference<K extends keyof Preferences>(key: K, value: NonNullable<Preferences[K]>): boolean {
	const path = prefsPath;
	if (path === null) return false;
	const next: Preferences = { ...read(path), [key]: value };
	prefs = next;
	try {
		mkdirSync(dirname(path), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, path);
	} catch {
		// an unwritable home: the choice still holds for this process
	}
	return true;
}

/** B1: remember an explicit effort pick for a profile. */
export function rememberEffort(profile: string, effort: string): boolean {
	return setPreference("effort", { ...(preferences().effort ?? {}), [profile]: effort });
}

/**
 * B1: the effort a NEW session of `profile` starts at, from the one last
 * picked — the picker's fallback: the level itself when the model has it,
 * else the endpoint's registry default, else none (default/default, no
 * reasoning key). Only a level that resolves for the model is returned, so
 * the session never carries a setting its first request would refuse.
 */
export function startingEffort(profile: Pick<ModelProfile, "model" | "baseUrl">, remembered: string | undefined): string | null {
	if (remembered === undefined || remembered === "default") return null;
	const effort = lookupModelMetadata(profile.model, profile.baseUrl)?.capabilities.reasoning?.effort ?? null;
	if (effort === null) return null;
	const legal = (level: string): boolean =>
		resolveReasoning(profile.model, { thinking: "default", effort: level } as ReasoningSetting, profile.baseUrl).ok;
	if ((effort.levels as readonly string[]).includes(remembered) && legal(remembered)) return remembered;
	return effort.default !== null && legal(effort.default) ? effort.default : null;
}

/** Tests: back to the state before startup. */
export function resetPreferences(): void {
	prefs = null;
	prefsPath = null;
}
