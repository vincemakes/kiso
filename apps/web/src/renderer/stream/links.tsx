import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { useOpenPanel } from "../panels/context.js";
import { previewUrl } from "../state/panels.js";

/**
 * Links and file chips in narration and the answer. An outside http(s) link opens in a new browser tab; a link to
 * localhost or 127.0.0.1 opens the Browser preview; a path inside the Work's folder becomes a chip that opens it in
 * the Open panel. A bare path becomes a chip only in prose and inline code (never in a code block), and only once the
 * host has said the file exists: one batched POST /desk/exists per finished block, remembered for the run.
 */

/** The Work's key in the routes (null: the folder in use). */
export const KeyContext = createContext<string | null>(null);
/** The Work in front of the person (its session id). */
export const WorkContext = createContext("");
/** The run a block belongs to: what /desk/exists answered is remembered per run. */
export const RunContext = createContext("");

const CANDIDATE = /(?<![\w/.@~-])(?:\.\/|\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*/g;
const EXT = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/** A path in the text as the folder sees it (relative, inside), or null when it does not look like a file path there. */
export function pathish(raw: string, root: string): string | null {
	let p = raw.replace(/[.,:;!?]+$/, "");
	if (p.startsWith("/")) {
		const r = [root, root.startsWith("/private/") ? root.slice(8) : `/private${root}`].find((x) => x !== "" && p.startsWith(`${x}/`));
		if (r === undefined) return null;
		p = p.slice(r.length + 1);
	}
	p = p.replace(/^\.\//, "");
	if (p === "" || p.split("/").some((part) => part === ".." || part === "") || !EXT.test(p)) return null;
	return p;
}

/** Where paths sit in a run of prose. */
export function pathsIn(text: string, root: string): { readonly at: number; readonly raw: string; readonly path: string }[] {
	return [...text.matchAll(CANDIDATE)].flatMap((m) => {
		const path = pathish(m[0], root);
		return path === null ? [] : [{ at: m.index, raw: m[0].replace(/[.,:;!?]+$/, ""), path }];
	});
}

const asked = new Map<string, Promise<boolean>>();

/** Which of `paths` are files in the folder; asked only while `on` (a finished block), each path once per run. */
export function useFound(paths: readonly string[], on: boolean): ReadonlySet<string> {
	const key = useContext(KeyContext);
	const run = useContext(RunContext);
	const [found, setFound] = useState<ReadonlySet<string>>(new Set());
	const uniq = [...new Set(paths)].slice(0, 64);
	const sig = uniq.join("\n");
	useEffect(() => {
		if (!on || uniq.length === 0) return;
		const id = (p: string): string => `${key ?? ""}\n${run}\n${p}`;
		const ask = uniq.filter((p) => !asked.has(id(p)));
		if (ask.length > 0) {
			const reply = fetch(`/desk/exists${key === null ? "" : `?key=${encodeURIComponent(key)}`}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paths: ask }) })
				.then((r) => (r.ok ? (r.json() as Promise<{ found: string[] }>) : { found: [] }))
				.then((r) => r.found, () => [] as string[]);
			for (const p of ask) asked.set(id(p), reply.then((f) => f.includes(p)));
		}
		let alive = true;
		void Promise.all(uniq.map((p) => asked.get(id(p))!)).then((oks) => alive && setFound(new Set(uniq.filter((_, i) => oks[i]))));
		return () => {
			alive = false;
		};
	}, [on, sig, key, run]);
	return found;
}

const TYPES: readonly [RegExp, string, ReactNode][] = [
	[/\.(md|markdown)$/i, "#3b5bdb", <path key="m" d="M7 15V9l2.5 3L12 9v6m3.5-6v6m-2-2 2 2 2-2" />],
	[/\.html?$/i, "#e8590c", <path key="h" d="M10 9 7.5 12l2.5 3m4-6 2.5 3-2.5 3" />],
	[/\.(png|jpe?g|gif|webp|svg)$/i, "#2f9e44", <path key="i" d="m6.5 16 3.5-3.5 2.5 2.5 2-2.5 3 3.5zM9.5 10.5a1 1 0 1 0 0-.01" />],
];

/** A file's type as a small tile: markdown, page, image, else code and text. */
export function FileIcon({ path }: { readonly path: string }): ReactNode {
	const [, fill, glyph] = TYPES.find(([re]) => re.test(path)) ?? [null, "#495057", <path key="c" d="M10 9 7.5 12l2.5 3m4-6 2.5 3-2.5 3" />];
	return (
		<svg className="fic" viewBox="0 0 24 24" aria-hidden="true">
			<rect x="3" y="4" width="18" height="16" rx="4" fill={fill} />
			<g fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
				{glyph}
			</g>
		</svg>
	);
}

/** An outside site's mark, from a small built-in table (no favicon is fetched); a globe else. */
function SiteIcon({ host }: { readonly host: string }): ReactNode {
	if (host === "github.com" || host.endsWith(".github.com"))
		return (
			<svg className="fic" viewBox="0 0 16 16" aria-hidden="true">
				<path fill="currentColor" d="M8 .5a7.5 7.5 0 0 0-2.4 14.6c.4.1.5-.2.5-.4v-1.3c-2.1.5-2.5-1-2.5-1-.3-.9-.8-1.1-.8-1.1-.7-.5.1-.5.1-.5.8.1 1.2.8 1.2.8.7 1.2 1.8.8 2.2.6.1-.5.3-.8.5-1-1.7-.2-3.4-.8-3.4-3.7 0-.8.3-1.5.8-2-.1-.2-.3-1 .1-2 0 0 .6-.2 2.1.8a7 7 0 0 1 3.8 0c1.4-1 2.1-.8 2.1-.8.4 1 .2 1.8.1 2 .5.5.8 1.2.8 2 0 2.9-1.8 3.5-3.4 3.7.3.2.5.7.5 1.4v2.1c0 .2.1.5.5.4A7.5 7.5 0 0 0 8 .5" />
			</svg>
		);
	return (
		<svg className="fic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
			<circle cx="8" cy="8" r="6.5" />
			<path d="M1.5 8h13M8 1.5c2 2 2 11 0 13M8 1.5c-2 2-2 11 0 13" />
		</svg>
	);
}

/** A file in the folder: its type and its path; a click opens it in the Open panel. A span, not a button: an inline box wraps and keeps the text baseline. */
export function Chip({ path, label }: { readonly path: string; readonly label?: ReactNode }): ReactNode {
	const open = useOpenPanel();
	return (
		<span role="button" tabIndex={0} className="fchip" data-chip={path} title={path} onClick={() => open("open", path)} onKeyDown={(e) => e.key === "Enter" && open("open", path)}>
			<FileIcon path={path} />
			{label ?? path}
		</span>
	);
}

/** A markdown link: out to a new tab, local to the preview, a file of the folder to its chip, anything else as its text. */
export function Link({ text, href, found, root }: { readonly text: ReactNode; readonly href: string; readonly found: ReadonlySet<string>; readonly root: string }): ReactNode {
	const open = useOpenPanel();
	if (/^(https?:\/\/)?(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(href)) {
		// a page on this computer, never this app's own host
		const local = previewUrl(href, location.port);
		if (local === null) return <span className="lk plain">{text}</span>;
		return (
			<span role="button" tabIndex={0} className="lk" data-link="local" onClick={() => open("web", local)} onKeyDown={(e) => e.key === "Enter" && open("web", local)}>
				<SiteIcon host="" />
				{text}
				<span className="hov">
					{t.linkLocal}
					<span className="o">{t.linkPanel}</span>
				</span>
			</span>
		);
	}
	if (/^https?:\/\//i.test(href)) {
		let url: URL;
		try {
			url = new URL(href);
		} catch {
			return <span className="lk plain">{text}</span>;
		}
		return (
			<a className="lk" data-link="out" href={url.href} target="_blank" rel="noopener noreferrer">
				<SiteIcon host={url.hostname} />
				{text}
				<span className="hov">
					{url.host}
					<span className="o">{t.linkOut}</span>
				</span>
			</a>
		);
	}
	const path = /^[a-z][a-z0-9+.-]*:/i.test(href) ? null : pathish(href, root);
	return path !== null && found.has(path) ? <Chip path={path} label={text} /> : <span className="lk plain" title={href}>{text}</span>;
}
