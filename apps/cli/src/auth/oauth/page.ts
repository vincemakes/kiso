/**
 * Graphite R3c — the page a browser shows when a sign-in comes back to
 * kiso's local callback. It is the one kiso surface outside the terminal,
 * so it wears the terminal's colours: the Graphite ground, ink and marks
 * for light and dark (the browser's `prefers-color-scheme`), the mark `✦`
 * beside `kiso`, one title, one sentence, centred, readable at phone width.
 * Static — no script, no request — and every word from outside (the
 * server's `error_description`) is escaped before it reaches the page.
 */

import { GRAPHITE } from "@vincemakes/kiso-tui-cells";

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** The page: `ok` marks the title in the success colour, `fail` in the
 *  failure colour, `note` leaves it in ink. */
export function callbackPage(kind: "ok" | "fail" | "note", title: string, body: string): string {
	const tone = (t: typeof GRAPHITE.light | typeof GRAPHITE.dark): string => (kind === "ok" ? t.ok : kind === "fail" ? t.fail : t.ink);
	const vars = (t: typeof GRAPHITE.light | typeof GRAPHITE.dark): string =>
		`--ground:${t.ground};--ink:${t.ink};--dim:${t.dim};--mark:${t.goldMark};--line:${t.line};--tone:${tone(t)}`;
	return [
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
		`<title>${escapeHtml(title)} · kiso</title>`,
		`<style>:root{${vars(GRAPHITE.light)}}@media (prefers-color-scheme:dark){:root{${vars(GRAPHITE.dark)}}}`,
		`html,body{margin:0;height:100%;background:var(--ground);color:var(--ink)}`,
		`body{display:flex;align-items:center;justify-content:center;font:16px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}`,
		`main{max-width:32rem;padding:2rem 1.25rem;text-align:center}`,
		`.mark{color:var(--dim);letter-spacing:.04em;margin:0 0 1.5rem}.mark b{color:var(--mark);font-weight:400}`,
		`h1{font-size:1.4rem;font-weight:700;color:var(--tone);margin:0 0 .75rem}`,
		`p{color:var(--dim);margin:0;overflow-wrap:anywhere}hr{border:0;border-top:1px solid var(--line);width:4rem;margin:1.5rem auto}</style>`,
		`<main><p class="mark"><b>✦</b> kiso</p><h1>${escapeHtml(title)}</h1><hr><p>${escapeHtml(body)}</p></main></html>`,
	].join("");
}
