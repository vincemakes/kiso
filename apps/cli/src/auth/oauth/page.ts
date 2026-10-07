/**
 * Graphite R3c — the page a browser shows when a sign-in comes back to
 * kiso's local callback. It is the one kiso surface outside the terminal,
 * so it looks like kiso.work: the quatrefoil mark and the `kiso` wordmark,
 * the site's warm ground and ink (a dark twin for `prefers-color-scheme:
 * dark`), a small mono status line with its dot, one large headline, one
 * sentence, and the reason in a mono box when there is one. Static — no
 * script, no request, no web font (the system's own faces stand in for
 * the site's) — and every word from outside (the server's
 * `error_description`) is escaped before it reaches the page.
 */

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c]!);

/** kiso's quatrefoil — the mark in `assets/logo.svg`, shared with kiso.work. */
const MARK =
	'<svg class="mark" viewBox="0 0 100 100" aria-hidden="true"><path fill="currentColor" d="m89 54c-0.5-1.3-0.8-2.7-0.8-3.9 0.2-5.5 7-11.1 9.5-19.4 2.2-7.3 2.2-17.3-5.2-23.8-2.7-2.4-7-4.7-12.7-4.7-2.6 0-5.3 0.4-7.8 1.2-4.7 1.5-7.8 3.5-14.5 7.8-2.6 1.5-4.6 2.6-7.5 2.6s-5-1.1-7.5-2.6c-6.7-4.3-11.1-7.2-15.8-8.3-1.6-0.4-3.5-0.7-6.1-0.7-5.7 0-10 2-12.9 4.7-7.3 6.7-7.4 16-5.2 22.9 2.6 7.9 8.4 13.1 8.9 18.8 0.2 1.6 0 3.5-0.9 5.4-2.8 5.7-8.4 10.9-8.9 21.5-0.2 4.2 0.3 8.9 2.8 13.1 2.1 3.3 6.5 8.3 16 8.5 12.5 0.2 18.8-6.9 25.8-9.6 1.3-0.5 2.5-0.7 3.8-0.7 6.7 0 11.4 6.9 21.9 9.8 2.2 0.7 4.7 1.1 7.5 1.2 4.2 0 7.5-0.8 10.2-2.3 4-2.1 6.5-5.8 7.7-8.8 1.1-2.9 1.6-5.9 1.6-8.8-0.2-10.6-7.3-17.4-9.9-23.9zm-71.2-3.6c6.4-0.4 11.6-1 17.4-4.2 3.3-1.8 6.4-4.5 8.6-7.3 3.1-4.2 5.6-9.5 6.1-17.1l0.1-2.2 0.2 2.2c1.2 13.1 9.3 20.8 16.2 24.3 4.5 2.4 8.7 3.6 15.8 4.1v0.2c-5.3 0.2-9.3 1-13.2 2.6-4.8 1.9-9.4 5.1-12.6 9.2-3.5 4.7-5.8 10-6.3 17.5l-0.1 1.4-0.2-2c-0.4-5.7-2.3-11-5.4-15.3-2.3-3.3-5.3-6.1-8.9-8.2-3.4-2.1-8-4.2-15.9-5.1l-1.8-0.1z"/></svg>';

const STYLE = [
	":root{--bg:#f7f7f4;--ink:#20211f;--muted:#666761;--line:#d9dad4;--ok:#2f7a3a;--fail:#b3261e;--sans:ui-sans-serif,-apple-system,'Helvetica Neue',Arial,sans-serif;--mono:ui-monospace,'SF Mono',Menlo,monospace;--pad:clamp(20px,5vw,72px)}",
	"@media (prefers-color-scheme:dark){:root{--bg:#151513;--ink:#ecece6;--muted:#9a9b93;--line:#33342f;--ok:#8fd19e;--fail:#f2877a}}",
	"*{box-sizing:border-box}html,body{margin:0;min-height:100%}",
	"body{min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased}",
	"header,footer{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:24px var(--pad)}",
	".logo{display:flex;align-items:center;gap:10px;font-size:26px;font-weight:600;letter-spacing:-1.3px}.mark{width:26px;height:26px}",
	".mono{font-family:var(--mono);font-size:11px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}",
	"main{flex:1;display:flex;flex-direction:column;justify-content:center;padding:32px var(--pad) 56px;max-width:880px}",
	".state{display:flex;align-items:center;gap:10px}.dot{width:7px;height:7px;border-radius:50%;background:var(--tone)}",
	"h1{margin:22px 0 0;font-size:clamp(40px,7vw,76px);line-height:1.03;font-weight:500;letter-spacing:-.06em}.period{color:var(--muted)}",
	"p.lead{margin:22px 0 0;color:var(--muted);font-size:17px;max-width:34rem}",
	"pre{margin:26px 0 0;padding:14px 16px;border:1px solid var(--line);font:13px/1.55 var(--mono);white-space:pre-wrap;overflow-wrap:anywhere;max-width:40rem}",
	"code{font:14px var(--mono);color:var(--ink)}",
	"footer{border-top:1px solid var(--line)}",
].join("");

export interface CallbackPage {
	/** the dot's colour, and the status line's word */
	readonly kind: "ok" | "fail" | "note";
	/** the headline — its trailing period is drawn muted, like the site's */
	readonly title: string;
	/** one sentence under it */
	readonly body: string;
	/** a reason from outside (the server's), shown verbatim in a mono box */
	readonly detail?: string;
	/** the status line's words (`signed in`, `sign-in failed`) */
	readonly state: string;
}

export function callbackPage(page: CallbackPage): string {
	const tone = page.kind === "ok" ? "var(--ok)" : page.kind === "fail" ? "var(--fail)" : "var(--muted)";
	const title = escapeHtml(page.title.replace(/\.$/, ""));
	return [
		`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`,
		`<title>${escapeHtml(page.title.replace(/\.$/, ""))} · kiso</title><style>${STYLE}</style>`,
		`<header><div class="logo">${MARK}kiso</div><span class="mono">ChatGPT sign-in</span></header>`,
		`<main style="--tone:${tone}"><div class="state mono"><span class="dot"></span>${escapeHtml(page.state)}</div>`,
		`<h1>${title}<span class="period">.</span></h1><p class="lead">${escapeHtml(page.body)}</p>`,
		page.detail === undefined ? "" : `<pre>${escapeHtml(page.detail)}</pre>`,
		`</main><footer><span class="mono">A small core. A long memory.</span><span class="mono">kiso.work</span></footer></html>`,
	].join("");
}
