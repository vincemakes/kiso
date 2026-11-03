import { en, type Strings } from "./en.js";

/** The active strings; a second locale would be chosen here. */
export const t: Strings = en;

/** Fill `{name}` slots in a string. */
export const fmt = (template: string, values: Readonly<Record<string, string | number>>): string => template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? ""));

/** 0:07, 1:05 — seconds as a clock. */
export const clock = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** 8 s, 1 min 5 s — a duration in words. */
export const span = (ms: number): string => {
	const s = Math.max(0, Math.round(ms / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

/** just now, 42s ago, 3m ago, 5h ago, 2d ago, then the date (Oct 3): when something happened, one rule everywhere. */
export const ago = (at: number, now: number): string => {
	const s = Math.max(0, Math.floor((now - at) / 1000));
	if (s < 10) return t.justNow;
	const [n, u] = s < 60 ? [s, "s"] : s < 3600 ? [Math.floor(s / 60), "m"] : s < 86_400 ? [Math.floor(s / 3600), "h"] : [Math.floor(s / 86_400), "d"];
	return u === "d" && n > 30 ? new Date(at).toLocaleDateString("en", { month: "short", day: "numeric" }) : fmt(t.ago, { n: `${n}${u}` });
};

/** 1.2k, 42 — a token count as the terminal says it. */
/** A token count: whole below a thousand, then k with one decimal, and from a million M as the terminal writes a window
 *  (1M, 1.05M: owner 2026-11-03, "1000k" reads oddly). */
export const tokens = (n: number | null): string =>
	n === null ? "?" : n < 1000 ? String(n) : n < 999_950 ? `${(Math.round(n / 100) / 10).toFixed(1)}k` : `${String(Math.round(n / 10_000) / 100)}M`;

/** A context window as the terminal's windowLabel writes it: 1M, 1.05M, 200k; a figure that is not round by tokens(). */
export const windowLabel = (n: number): string => (n >= 1_000_000 && n % 10_000 === 0 ? `${n / 1_000_000}M` : n % 1000 === 0 ? `${n / 1000}k` : tokens(n));
