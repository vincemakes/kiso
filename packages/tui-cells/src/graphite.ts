/**
 * Graphite (design.md §2, §3.4) — the colour tokens, the output tier, and
 * the surfaces derived from the ground the terminal actually reported.
 *
 * PURE: no process state is read except where a caller passes it in, so
 * every decision here is testable without a terminal. `render.ts` turns
 * these colours into SGR bytes; this module only decides the colours.
 */

import { groundFrom, relativeLuminance, type Rgb } from "./ground.js";

export type Kind = "light" | "dark";
/** How colour reaches the terminal: 24-bit (`38;2;r;g;b`) where the
 *  terminal says it renders it, the nearest xterm-256 index otherwise. */
export type Tier = "24bit" | "256";

/** The Graphite table (design.md §2), on the two reference grounds. */
export const GRAPHITE = {
	light: {
		ground: "#ffffff",
		ink: "#111111",
		ink2: "#444444",
		dim: "#646464",
		rail: "#8c8c8c",
		line: "#e6e6e6",
		washRun: "#edf2fb",
		washDone: "#f1f1f1",
		washFail: "#fbecea",
		washAsk: "#f7f1e3",
		human: "#f7efdc",
		humanInk: "#171923",
		gold: "#8a5a00",
		goldMark: "#c9921f",
		blue: "#2456b5",
		code: "#e4ebf8",
		ok: "#2f7a3a",
		fail: "#b3261e",
		add: "#dff0e2",
		del: "#fadfdc",
		track: "#e2e2e2",
	},
	// 0.47.1 — the dark table re-adapted (owner, 2026-10-07: preset D on
	// the dark palette page): the surfaces were a few levels above the
	// ground and read as heavy on a black terminal; they rise a step, and
	// dim and ink2 rise with them to keep the floor. washAsk and code sit
	// just under D's values (#524222, #30406a) so every pair of
	// TEXT_PAIRS still clears 4.5, in the 256 tier too.
	dark: {
		ground: "#0b0b0b",
		ink: "#ededed",
		ink2: "#c2c2c2",
		dim: "#a4a4a4",
		rail: "#6b6b6b",
		line: "#3a3a3a",
		washRun: "#2b3854",
		washDone: "#333333",
		washFail: "#4d2b28",
		washAsk: "#483818",
		human: "#e8dfc6",
		humanInk: "#141620",
		gold: "#e3b04b",
		goldMark: "#e3b04b",
		blue: "#82a8f5",
		code: "#283658",
		ok: "#8fd19e",
		fail: "#f2877a",
		add: "#2a5034",
		del: "#5e302d",
		track: "#474747",
	},
} as const;

export type Token = Exclude<keyof (typeof GRAPHITE)["light"], "ground">;
export type Colours = { readonly [K in Token | "ground"]: Rgb };

/** The tokens that are GROUNDS near the terminal's own (§3.4): each is
 *  derived from the reported ground. Every other token is fixed per kind. */
export const SURFACES = ["line", "washRun", "washDone", "washFail", "washAsk", "human", "code", "add", "del", "track"] as const satisfies readonly Token[];

/** The text tokens that read on the ground and on the card surfaces (§2.1). */
export const CARD_TEXT = ["ink", "ink2", "dim", "gold", "blue", "ok", "fail"] as const satisfies readonly Token[];
export const CARDS = ["washRun", "washDone", "washFail", "washAsk"] as const satisfies readonly Token[];
type Surface = Token | "ground";
/** Every text-on-surface pair a human reads (§2.1's floor applies to each). */
export const TEXT_PAIRS: readonly (readonly [Token, Surface])[] = [
	...(["ground", ...CARDS] as const).flatMap((surface) => CARD_TEXT.map((text) => [text, surface] as const)),
	["humanInk", "human"],
	["blue", "code"],
	["ink", "add"],
	["ink", "del"],
];
export const FLOOR = 4.5;
/** The floor for a GRAPHIC — a mark, not text (WCAG 1.4.11). The breath
 *  never drops below it (§2.2). */
export const GRAPHIC_FLOOR = 3;

export function hexRgb(hex: string): Rgb {
	const n = Number.parseInt(hex.slice(1), 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbHex({ r, g, b }: Rgb): string {
	return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** The WCAG contrast ratio, the measure of §2's floor. */
export function contrast(a: Rgb, b: Rgb): number {
	const [x, y] = [relativeLuminance(a), relativeLuminance(b)].sort((p, q) => q - p) as [number, number];
	return (x + 0.05) / (y + 0.05);
}

/** `t` of the way from `a` to `b`, per channel. */
export function mix(a: Rgb, b: Rgb, t: number): Rgb {
	const c = (x: number, y: number): number => Math.round(x + (y - x) * t);
	return { r: c(a.r, b.r), g: c(a.g, b.g), b: c(a.b, b.b) };
}

const REF_LIGHT = hexRgb(GRAPHITE.light.ground);
const REF_DARK = hexRgb(GRAPHITE.dark.ground);

/**
 * §3.4 — one surface for any ground. A DARK ground: per channel an affine
 * map `s = a + k·g`, fitted so that the white reference ground gives the
 * table's white value and the black one its black value — a terminal
 * whose black is `#1e1e1e` gets a card that sits the same distance off
 * ITS ground, and the distance narrows as a dark ground lightens, which
 * keeps the text above the floor on the lighter dark themes. A LIGHT
 * ground: the light table, moved by how far the ground sits from white.
 * The two reference grounds reproduce the table exactly.
 *
 * 0.47.1 (the dark table's re-adaptation): DECLARED REVERSAL for the
 * light grounds only. The one map through both tables tied them to the
 * dark table — lifting the dark cards pulled a card on `#eeeeee` to within
 * 1.09:1 of its ground. A light ground now answers to the light table
 * alone; on the light grounds measured the cards move by a channel step
 * or two at most.
 */
export function deriveSurface(token: Token, ground: Rgb): Rgb {
	if (groundFrom(ground) === "light") {
		const s = hexRgb(GRAPHITE.light[token]);
		const shift = (sc: number, rc: number, g: number): number => Math.max(0, Math.min(255, Math.round(sc + (g - rc))));
		return { r: shift(s.r, REF_LIGHT.r, ground.r), g: shift(s.g, REF_LIGHT.g, ground.g), b: shift(s.b, REF_LIGHT.b, ground.b) };
	}
	const w = hexRgb(GRAPHITE.light[token]);
	const d = hexRgb(GRAPHITE.dark[token]);
	const chan = (wc: number, dc: number, lw: number, ld: number, g: number): number => {
		const k = (wc - dc) / (lw - ld);
		return Math.max(0, Math.min(255, Math.round(dc + k * (g - ld))));
	};
	return {
		r: chan(w.r, d.r, REF_LIGHT.r, REF_DARK.r, ground.r),
		g: chan(w.g, d.g, REF_LIGHT.g, REF_DARK.g, ground.g),
		b: chan(w.b, d.b, REF_LIGHT.b, REF_DARK.b, ground.b),
	};
}

function table(kind: Kind): Colours {
	const t = GRAPHITE[kind];
	return Object.fromEntries(Object.entries(t).map(([k, v]) => [k, hexRgb(v)])) as Colours;
}

/** A colour as the terminal will show it: itself in the 24-bit tier, the
 *  nearest xterm-256 entry in the 256 tier. The floor is checked on what
 *  is SHOWN — rounding to the nearest index can cost a pair its contrast. */
export function shown(c: Rgb, tier: Tier): Rgb {
	return tier === "24bit" ? c : xterm256(nearest256(c));
}

/** One pair's ratio as shown. The ground is the terminal's own colour and
 *  is never rounded; every token kiso writes is. */
function pairRatio(c: Colours, text: Token, surface: Surface, tier: Tier): number {
	const s = surface === "ground" ? c.ground : shown(c[surface], tier);
	return contrast(shown(c[text], tier), s);
}

/** The weakest text-on-surface pair of a colour set, as shown in `tier`. */
export function weakestPair(c: Colours, tier: Tier = "24bit"): { pair: readonly [Token, Surface]; ratio: number } {
	let worst = { pair: TEXT_PAIRS[0]!, ratio: Number.POSITIVE_INFINITY };
	for (const pair of TEXT_PAIRS) {
		const ratio = pairRatio(c, pair[0], pair[1], tier);
		if (ratio < worst.ratio) worst = { pair, ratio };
	}
	return worst;
}

/** A text token moved toward the kind's extreme (white on a dark ground,
 *  black on a light one) just far enough that it clears the floor, as
 *  shown, on every surface it reads on. Unmoved when it already does. */
function lifted(c: Colours, token: Token, kind: Kind, tier: Tier): Rgb {
	const on = TEXT_PAIRS.filter(([t]) => t === token).map(([, s]) => s);
	const extreme: Rgb = kind === "dark" ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
	for (let t = 0; t <= 1.0001; t += 0.02) {
		const cand = { ...c, [token]: mix(c[token], extreme, t) } as Colours;
		if (on.every((s) => pairRatio(cand, token, s, tier) >= FLOOR)) return cand[token];
	}
	return extreme;
}

/**
 * The colours for one screen. `ground` is the RGB the terminal reported
 * (OSC 11), or null when the ground was resolved without a colour — an
 * explicit theme, the terminal's scheme report, COLORFGBG — in which case
 * the table is used as it stands.
 *
 * A reported ground of the OTHER kind (a human who set `theme: light` on
 * a black terminal) derives nothing: the answer the human gave wins, and
 * surfaces fitted to a ground the text tokens were not chosen for would
 * be wrong in both directions.
 *
 * On a reported ground the surfaces are derived (§3.4), and a text token
 * that would fall under the floor — as shown in `tier` — on the ground or
 * on a surface is moved toward the kind's extreme just far enough to clear
 * it: a lighter dark theme lifts `dim`, never the other way. The table's
 * own values pass on their reference grounds in both tiers, so there
 * nothing moves. If a pair is still under the floor, the table is used.
 */
/** The last derivation, kept: the opening's rules and wordmark ask for
 *  the colours on every frame (the banner is a live cell), and the answer
 *  only moves with its three inputs (the render-perf pass, 2026-10-07).
 *  Callers read the table; none writes to it. */
let lastColours: { kind: Kind; r: number; g: number; b: number; tier: Tier; out: Colours } | null = null;

export function graphiteColours(kind: Kind, ground: Rgb | null, tier: Tier = "24bit"): Colours {
	const r = ground === null ? -1 : ground.r;
	const g = ground === null ? -1 : ground.g;
	const b = ground === null ? -1 : ground.b;
	const k = lastColours;
	if (k !== null && k.kind === kind && k.tier === tier && k.r === r && k.g === g && k.b === b) return k.out;
	const out = deriveColours(kind, ground, tier);
	lastColours = { kind, r, g, b, tier, out };
	return out;
}

function deriveColours(kind: Kind, ground: Rgb | null, tier: Tier): Colours {
	const base = table(kind);
	if (ground === null || groundFrom(ground) !== kind) return base;
	const derived: Record<string, Rgb> = { ...base, ground };
	for (const s of SURFACES) derived[s] = deriveSurface(s, ground);
	for (const t of new Set(TEXT_PAIRS.map(([text]) => text))) derived[t] = lifted(derived as Colours, t, kind, tier);
	const out = derived as Colours;
	return weakestPair(out, tier).ratio >= FLOOR ? out : base;
}

/**
 * The command breath (§5.2): seven steps from `gold` toward the running
 * card's ground, peak → floor → peak. The floor is the deepest step that
 * still meets the graphic floor on that ground (§2.2): the mark dims and
 * never disappears.
 */
export function breathRamp(c: Colours): readonly Rgb[] {
	const card = c.washRun;
	let deepest = 0;
	for (let t = 0; t <= 1.0001; t += 0.01) {
		if (contrast(mix(c.gold, card, t), card) >= GRAPHIC_FLOOR) deepest = t;
		else break;
	}
	const at = (f: number): Rgb => mix(c.gold, card, deepest * f);
	return [at(0), at(1 / 3), at(2 / 3), at(1), at(2 / 3), at(1 / 3), at(0)];
}

/** The xterm-256 palette's colour for an index 16–255 (the cube and the
 *  grey ramp; the first sixteen are the terminal's own and never chosen). */
export function xterm256(index: number): Rgb {
	if (index >= 232) {
		const v = 8 + (index - 232) * 10;
		return { r: v, g: v, b: v };
	}
	const i = index - 16;
	const step = (n: number): number => (n === 0 ? 0 : 55 + n * 40);
	return { r: step(Math.floor(i / 36)), g: step(Math.floor(i / 6) % 6), b: step(i % 6) };
}

/** The nearest xterm-256 index (16–255) to a colour, by squared distance
 *  in RGB — the 256 tier's whole translation. */
export function nearest256(c: Rgb): number {
	let best = 16;
	let bestD = Number.POSITIVE_INFINITY;
	for (let i = 16; i <= 255; i += 1) {
		const x = xterm256(i);
		const d = (x.r - c.r) ** 2 + (x.g - c.g) ** 2 + (x.b - c.b) ** 2;
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	}
	return best;
}

/** §2 — 24-bit where the terminal says it renders it. `COLORTERM` is the
 *  standard statement; anything else gets the 256 tier, which every
 *  terminal kiso docks in renders. */
export function colourTier(colorterm: string | undefined): Tier {
	const v = colorterm?.trim().toLowerCase();
	return v === "truecolor" || v === "24bit" ? "24bit" : "256";
}

/** 0.47.1 (owner, 2026-10-07) — 24-bit where the terminal is KNOWN to
 *  render it, though it does not say so in COLORTERM. Windows Terminal is
 *  the case that found it: drawn in the 256 tier, the person's cream block
 *  became pink (index 224) and its gold edge olive (186). Each terminal is
 *  recognised by what it sets; the list is the reference implementation's.
 *  Inside tmux or screen only COLORTERM counts — the outer terminal's
 *  variables are inherited, its rendering is not. Apple Terminal says it
 *  in COLORTERM where it renders 24-bit (§2), and keeps the 256 tier
 *  otherwise. PURE: the environment and the platform are passed in. */
export function terminalTier(env: Readonly<Record<string, string | undefined>>, platform: string): Tier {
	if (colourTier(env.COLORTERM) === "24bit") return "24bit";
	const term = (env.TERM ?? "").toLowerCase();
	if (env.TMUX !== undefined || term.startsWith("tmux") || term.startsWith("screen")) return "256";
	const program = (env.TERM_PROGRAM ?? "").toLowerCase();
	const known =
		env.WT_SESSION !== undefined ||
		env.ITERM_SESSION_ID !== undefined ||
		env.WEZTERM_PANE !== undefined ||
		env.KITTY_WINDOW_ID !== undefined ||
		env.GHOSTTY_RESOURCES_DIR !== undefined ||
		["iterm.app", "wezterm", "ghostty", "kitty", "vscode", "warpterminal", "alacritty"].includes(program) ||
		term.includes("ghostty") ||
		term === "alacritty" ||
		(env.TERMINAL_EMULATOR ?? "").toLowerCase() === "jetbrains-jediterm" ||
		// a Windows console renders 24-bit even where Windows Terminal hosts
		// it without WT_SESSION (cmd.exe from Win+R)
		platform === "win32";
	return known ? "24bit" : "256";
}

export function fg(c: Rgb, tier: Tier): string {
	return tier === "24bit" ? `\x1b[38;2;${c.r};${c.g};${c.b}m` : `\x1b[38;5;${nearest256(c)}m`;
}

export function bg(c: Rgb, tier: Tier): string {
	return tier === "24bit" ? `\x1b[48;2;${c.r};${c.g};${c.b}m` : `\x1b[48;5;${nearest256(c)}m`;
}
