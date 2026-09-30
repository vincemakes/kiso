/**
 * 0.40.6 — `/settings`: what kiso is running with, where each value came
 * from, and how to change it.
 *
 * The owner, 2026-09-23, asked whether kiso has a help for what can be
 * configured. `/help` lists the commands and `?` the keys; the settings
 * lived only in docs/configuration.md and in files the user had to open.
 *
 * READ-ONLY by design: the config file stays the human's. The layers are
 * the documented precedence — flag > env > project config > user config >
 * default — and a value that no layer explains was set in this session
 * (`/mode`, `/model`). Pure: every input is passed in, so each row is
 * testable without a session.
 */
import type { KisoConfig } from "./config.js";
import { envModeLayer, parseMode, resolveModeLayers, type ModeSource } from "./mode.js";

export interface SettingsInput {
	readonly user: KisoConfig | null;
	readonly project: KisoConfig | null;
	readonly env: Readonly<Record<string, string | undefined>>;
	/** the --mode / --model values on the command line, when given */
	readonly modeFlag?: string;
	readonly modelFlag?: string;
	/** whether --dont-ask was on the command line */
	readonly dontAskFlag?: boolean;
	/** what is live now */
	readonly mode: string;
	readonly dontAsk?: boolean;
	readonly model: { readonly label: string; readonly profile: string | null; readonly switched: boolean };
	readonly ground: string;
	readonly floorOn: boolean;
	readonly window: string;
	readonly thinkingHidden: boolean;
	readonly thinkingRemembered: boolean;
	readonly version: string;
}

interface Row {
	readonly name: string;
	readonly value: string;
	readonly from: string;
	readonly change: string;
}

const MODE_LAYER: Readonly<Record<ModeSource, string>> = { flag: "--mode", env: "env KISO_MODE", project: "project config", user: "user config", default: "default" };

/** What a layer wrote for the tier — an old name is named, so a person
 *  learns the new one from the row that shows it. */
function writtenMode(i: SettingsInput, source: ModeSource): string | undefined {
	return source === "flag" ? i.modeFlag : source === "env" ? i.env.KISO_MODE : source === "project" ? i.project?.mode : source === "user" ? i.user?.mode : undefined;
}

function modeFrom(i: SettingsInput, source: ModeSource): string {
	const w = writtenMode(i, source);
	return w === "bypass" || w === "dontAsk" ? `${MODE_LAYER[source]} (written "${w}")` : MODE_LAYER[source];
}

/** The switch's layer: its own key there, or — the resolution's other
 *  way in — that layer's tier written as the old name dontAsk. */
function dontAskFrom(i: SettingsInput, source: ModeSource): string {
	if (source === "default") return "default";
	const own = source === "flag" ? i.dontAskFlag === true : source === "env" ? envModeLayer(i.env).dontAsk !== undefined : source === "project" ? i.project?.dontAsk !== undefined : i.user?.dontAsk !== undefined;
	if (own) return source === "flag" ? "--dont-ask" : source === "env" ? "env KISO_DONT_ASK" : MODE_LAYER[source];
	return `${MODE_LAYER[source]} (written "dontAsk")`;
}

function modeLayers(i: SettingsInput): Parameters<typeof resolveModeLayers>[0] {
	return {
		flag: { ...(i.modeFlag !== undefined ? { mode: i.modeFlag } : {}), ...(i.dontAskFlag === true ? { dontAsk: true } : {}) },
		env: envModeLayer(i.env),
		project: i.project,
		user: i.user,
	};
}

function modeRow(i: SettingsInput): Row {
	const change = "/mode or shift+tab; \"mode\" in ~/.kiso/config.json";
	// the layers decided at start-up; a live tier they do not explain was
	// set in this session
	const resolved = resolveModeLayers(modeLayers(i));
	const from = parseMode(i.mode)?.mode === resolved.mode ? modeFrom(i, resolved.from.mode) : "set in this session";
	return { name: "mode", value: i.mode, from, change };
}

function dontAskRow(i: SettingsInput): Row {
	const change = "/dont-ask; --dont-ask; \"dontAsk\": true in ~/.kiso/config.json";
	const on = i.dontAsk === true;
	const resolved = resolveModeLayers(modeLayers(i));
	const from = (resolved.dontAsk !== "off") === on ? dontAskFrom(i, resolved.from.dontAsk) : "set in this session";
	return { name: "don't ask", value: on ? "on — what would ask is refused" : "off", from, change };
}

function modelRow(i: SettingsInput): Row {
	const change = "/model; \"model\" in ~/.kiso/config.json";
	const p = i.model.profile;
	const from = i.model.switched
		? "set in this session"
		: i.modelFlag !== undefined
			? "--model"
			: p !== null && i.project?.model === p
				? "project config"
				: p !== null && i.user?.model === p
					? "user config"
					: i.env.OPENAI_API_KEY !== undefined && p === null
						? "env OPENAI_API_KEY"
						: "default";
	return { name: "model", value: i.model.label, from, change };
}

function themeRow(i: SettingsInput): Row {
	const change = "\"theme\": \"dark\" | \"light\" in ~/.kiso/config.json; KISO_THEME for one run";
	if (i.env.KISO_THEME !== undefined) return { name: "theme", value: i.env.KISO_THEME, from: "env KISO_THEME", change };
	if (i.user?.theme !== undefined) return { name: "theme", value: i.user.theme, from: "user config", change };
	return { name: "theme", value: i.ground, from: "the terminal (detected)", change };
}

function layered<K extends keyof KisoConfig>(i: SettingsInput, key: K): { value: KisoConfig[K] | undefined; from: string } {
	if (i.project?.[key] !== undefined) return { value: i.project[key], from: "project config" };
	if (i.user?.[key] !== undefined) return { value: i.user[key], from: "user config" };
	return { value: undefined, from: "default" };
}

export function settingsRows(i: SettingsInput): string[] {
	const trust = layered(i, "projectTrust");
	const auto = i.env.KISO_AUTO_COMPACT !== undefined ? { value: i.env.KISO_AUTO_COMPACT, from: "env KISO_AUTO_COMPACT" } : layered(i, "autoCompact");
	const rows: Row[] = [
		modelRow(i),
		modeRow(i),
		dontAskRow(i),
		themeRow(i),
		{
			name: "floor",
			value: i.floorOn ? "on — irrecoverable deletes are refused in every mode" : "off",
			from: i.user?.floor !== undefined ? "user config" : "default",
			change: "\"floor\": \"off\" in ~/.kiso/config.json (user config only)",
		},
		{ name: "window", value: i.window, from: "the window chain (see /status)", change: "\"contextWindow\" on the profile; KISO_CONTEXT_WINDOW for one run" },
		{ name: "compaction", value: "in-run: past half the window at a phase end, past 80% at once", from: "built in", change: "/compact on demand" },
		{
			name: "auto-compact",
			value: auto.value === undefined ? "off" : typeof auto.value === "object" ? `at ${(auto.value as { thresholdRatio: number }).thresholdRatio} of the window, at a run's start` : String(auto.value),
			from: auto.from,
			change: "\"autoCompact\" in config; KISO_AUTO_COMPACT",
		},
		{ name: "project trust", value: trust.value ?? "ask", from: trust.from, change: "\"projectTrust\": \"ask\" | \"never\" in config" },
		{
			name: "thinking",
			value: i.thinkingHidden ? "hidden — one line per block" : "shown",
			from: i.thinkingRemembered ? "ctrl+t (remembered)" : "default",
			change: "ctrl+t",
		},
		{ name: "version", value: i.version, from: "running", change: "kiso update" },
	];
	const width = Math.max(...rows.map((r) => r.name.length)) + 2;
	return rows.map((r) => `${r.name.padEnd(width)}${r.value}\n${" ".repeat(width)}from ${r.from} · change: ${r.change}`);
}
