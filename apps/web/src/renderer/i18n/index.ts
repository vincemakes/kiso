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
export const tokens = (n: number | null): string => (n === null ? "?" : n < 1000 ? String(n) : `${(Math.round(n / 100) / 10).toFixed(1)}k`);
