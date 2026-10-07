/**
 * 0.40.0 — a PERSON invokes a skill.
 *
 * `/skill <name> [args…]`, or `/<name> [args…]` when no built-in command
 * has that name — built-ins win, always, so installing a skill can never
 * take a command away. The invocation is a USER TURN: the SKILL.md body,
 * then the person's args after a blank line, submitted through the same
 * path as typed input. The durable record says the turn came from the
 * person (`source` stays "user") and says HOW it was composed in `via`,
 * which carries the line they typed — so the chip, the resume tail and the
 * session's name show what the person wrote, not a body they never saw.
 *
 * Pure: the catalog comes from the skills extension's own scan (one scan,
 * one answer — the model's index and this door are one list), and every
 * outcome is data. The dispatcher does the printing and the submitting.
 */

import type { UserInputVia } from "@vincemakes/kiso-core";
import type { SkillsCatalog } from "@vincemakes/kiso-skills-ext";
import { bandHeader } from "@vincemakes/kiso-tui-cells/strings";
import { cutLine, escapeTerminal, palette } from "@vincemakes/kiso-tui-cells/render";
import { visibleWidth, widthCut } from "@vincemakes/kiso-tui-cells/width";

export type SkillOutcome =
	| { readonly kind: "submit"; readonly content: string; readonly via: UserInputVia }
	| { readonly kind: "error"; readonly message: string }
	| { readonly kind: "list" };

/**
 * What a submitted line asks of the skills, if anything. `null` means the
 * line is not a skill request, and the dispatcher goes on as before — which
 * is how a typo stays "unknown command" rather than becoming a skill error.
 */
export function resolveSkillLine(trimmed: string, catalog: SkillsCatalog | null, builtins: readonly string[]): SkillOutcome | null {
	if (trimmed.includes("\n") || !trimmed.startsWith("/")) return null;
	const [word = "", ...rest] = trimmed.split(/\s+/);
	if (word === "/skills") return rest.length === 0 ? { kind: "list" } : { kind: "error", message: "usage: /skills (no arguments) — /skill <name> [args] runs one" };
	if (word === "/skill") {
		const [name = ""] = rest;
		if (name === "") return { kind: "error", message: "usage: /skill <name> [args…] — /skills lists them" };
		return invoke(name, argsOf(trimmed, 2), trimmed, catalog);
	}
	// `/<name>`: only a word no built-in claims, and only a skill that
	// exists — anything else is the dispatcher's own "unknown command".
	if (builtins.includes(word)) return null;
	const name = word.slice(1);
	if (catalog === null || (!catalog.entries.some((e) => e.name === name) && !catalog.broken.some((b) => b.dir === name))) return null;
	return invoke(name, argsOf(trimmed, 1), trimmed, catalog);
}

/** The args as typed — everything after the first `words` words, with its
 *  own spacing kept. A skill that asks for a path wants the path, not a
 *  re-joined approximation of it. */
function argsOf(trimmed: string, words: number): string {
	let rest = trimmed;
	for (let i = 0; i < words; i += 1) rest = rest.replace(/^\S+\s*/, "");
	return rest;
}

function invoke(name: string, args: string, line: string, catalog: SkillsCatalog | null): SkillOutcome {
	const entry = catalog?.entries.find((e) => e.name === name);
	if (entry === undefined) {
		const broken = catalog?.broken.find((b) => b.dir === name);
		if (broken !== undefined) return { kind: "error", message: `skill "${name}" cannot load: ${broken.reason}` };
		const near = nearest(name, catalog?.entries.map((e) => e.name) ?? []);
		const hint = near.length > 0 ? ` — nearest: ${near.join(", ")}` : "";
		return { kind: "error", message: `no skill named "${name}"${hint} (/skills lists them)` };
	}
	if (!entry.userInvocable) return { kind: "error", message: `skill "${name}" is for the model only (user-invocable: false)` };
	const read = catalog!.body(name);
	if ("error" in read) return { kind: "error", message: `skill "${name}" cannot load: ${read.error}` };
	return {
		kind: "submit",
		content: args === "" ? read.body : `${read.body}\n\n${args}`,
		via: { kind: "skill", name, line },
	};
}

/** Up to three installed names close to the one typed: a shared prefix, or
 *  within two edits. Closest first; nothing when nothing is close — a
 *  suggestion that is not near is noise. */
export function nearest(name: string, names: readonly string[]): string[] {
	const scored = names
		.map((n) => ({ n, d: n.startsWith(name) || name.startsWith(n) ? 0 : distance(name, n) }))
		.filter((s) => s.d <= 2)
		.sort((a, b) => a.d - b.d || (a.n < b.n ? -1 : 1));
	return scored.slice(0, 3).map((s) => s.n);
}

function distance(a: string, b: string): number {
	const row = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i += 1) {
		let prev = row[0]!;
		row[0] = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cur = row[j]!;
			row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
			prev = cur;
		}
	}
	return row[b.length]!;
}

/** `/skills` — the skills grouped by the directory they really live in,
 *  each directory named ONCE as a header: project and user skills are
 *  merged into one scan directory by symlink, so the scan root would name a
 *  temp directory nobody can find — `sourceOf` resolves an entry's
 *  directory to where it came from. Under each: `/name — description`, a
 *  `model only` tag for `user-invocable: false`, then the broken entries
 *  with the loader's own reason. */
export function skillsRows(catalog: SkillsCatalog | null, sourceOf: (dir: string) => string, userDir: string): string[] {
	const entries = catalog?.entries ?? [];
	const broken = catalog?.broken ?? [];
	if (entries.length === 0 && broken.length === 0) return [`no skills installed — add one as ${userDir}/<name>/SKILL.md`];
	const groups = new Map<string, string[]>();
	const add = (dir: string, row: string): void => {
		const src = sourceOf(dir);
		groups.set(src, [...(groups.get(src) ?? []), row]);
	};
	for (const e of entries) add(e.dir, `  /${e.name} — ${e.description}${e.userInvocable ? "" : " (model only)"}`);
	for (const b of broken) add(b.dir, `  ${b.dir} — cannot load: ${b.reason}`);
	const rows: string[] = [];
	for (const [src, list] of groups) rows.push(src, ...list);
	rows.push("/<name> [args] or /skill <name> [args] runs one · a built-in command wins a shared name");
	return rows;
}

/** The last `cells` cells of `text`, by display width. */
function leftCut(text: string, cells: number): string {
	const chars = Array.from(text);
	let out = "";
	for (let i = chars.length - 1; i >= 0; i -= 1) {
		if (visibleWidth(chars[i]! + out) > cells) break;
		out = chars[i]! + out;
	}
	return out;
}

/**
 * The sheets round (owner, 2026-10-06) — `/skills` on a dock is a sheet
 * over the input, the shape `/status` has (§8.16). The band says how many,
 * how many cannot load, and where they live when that is one place
 * (`skills · 3 · 1 cannot load · ~/.kiso/skills`); each skill is one row,
 * `/name` in ink in a measured column and its description dim, cut by
 * cells; with more than one place, the place ends the row. A skill that
 * cannot load says why, in the failure colour. How to run one is the
 * closing row. On a pipe `/skills` prints `skillsRows`, unchanged.
 */
export function skillsSheetRows(catalog: SkillsCatalog | null, sourceOf: (dir: string) => string, userDir: string, W: number): string[] {
	const p = palette();
	const entries = catalog?.entries ?? [];
	const broken = catalog?.broken ?? [];
	const close = `  ${p.dim}/<name> runs one \u00b7 a built-in wins its name \u00b7 esc closes${p.reset}`;
	if (entries.length === 0 && broken.length === 0) {
		return [bandHeader("skills \u00b7 none", W), `  ${p.dim}add one as ${escapeTerminal(userDir)}/<name>/SKILL.md${p.reset}`, close].map((r) => cutLine(r, W));
	}
	const places = [...new Set([...entries.map((e) => sourceOf(e.dir)), ...broken.map((b) => sourceOf(b.dir))])];
	const facts = [String(entries.length), ...(broken.length > 0 ? [`${broken.length} cannot load`] : [])];
	// the place is cut from the LEFT when the band cannot hold it (P4's
	// rule for a path in a band name): its end — the folder's own name —
	// and the rule after it stay on screen
	const head = `skills \u00b7 ${facts.join(" \u00b7 ")}`;
	const where = places.length === 1 ? escapeTerminal(places[0]!) : "";
	const roomFor = Math.max(0, W - 8 - visibleWidth(head) - 3);
	const shown = where === "" || roomFor < 2 ? "" : visibleWidth(where) <= roomFor ? where : `\u2026${leftCut(where, roomFor - 1)}`;
	const rows = [bandHeader(shown === "" ? head : `${head} \u00b7 ${shown}`, W)];
	const names = [...entries.map((e) => `/${escapeTerminal(e.name)}`), ...broken.map((b) => escapeTerminal(b.dir))];
	const nw = Math.max(...names.map((n) => visibleWidth(n))) + 2;
	const fit = (text: string, room: number): string => (visibleWidth(text) <= room ? text : `${widthCut(text, Math.max(1, room - 1))}…`);
	const place = (dir: string): string => (places.length > 1 ? ` \u00b7 ${escapeTerminal(sourceOf(dir))}` : "");
	const room = Math.max(1, W - 2 - nw - 1);
	for (const e of entries) {
		const name = `/${escapeTerminal(e.name)}`;
		const what = `${escapeTerminal(e.description)}${e.userInvocable ? "" : " (model only)"}${place(e.dir)}`;
		rows.push(`  ${name}${" ".repeat(nw - visibleWidth(name))}${p.dim}${fit(what, room)}${p.reset}`);
	}
	for (const b of broken) {
		const name = escapeTerminal(b.dir);
		rows.push(`  ${p.dim}${name}${" ".repeat(nw - visibleWidth(name))}${p.reset}${p.fail}${fit(`cannot load: ${escapeTerminal(b.reason)}${place(b.dir)}`, room)}${p.fgEnd}`);
	}
	rows.push(close);
	return rows.map((r) => cutLine(r, W));
}

/**
 * 0.40.1 (owner's ruling, revoking the 0.41.0 deferral) — the installed
 * skills as `/` menu entries. The same rule the dispatcher follows, so the
 * menu never offers what `/<name>` would not run: invocable skills only
 * (`user-invocable: false` stays the model's), a name a person can type
 * after `/`, and never a name a built-in claims — the built-in wins. The
 * description is cut so a long one cannot crowd the band.
 */
export function skillMenuItems(catalog: SkillsCatalog | null, builtins: readonly string[]): { readonly name: string; readonly desc: string }[] {
	if (catalog === null) return [];
	const taken = new Set(builtins);
	const cut = (text: string, n: number): string => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);
	return catalog.entries
		.filter((e) => e.userInvocable && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(e.name) && !taken.has(`/${e.name}`))
		.map((e) => ({ name: `/${e.name}`, desc: `${cut(e.description, 56)} · skill` }));
}
