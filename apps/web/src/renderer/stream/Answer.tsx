import { Fragment, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { render, type Block, type Inline } from "../state/markdown.js";
import { Chip, Link, pathish, pathsIn, useFound } from "./links.js";
import { RootContext } from "./root.js";

/** What inline drawing needs to turn paths into chips: the files the host confirmed, and the folder's real path. */
interface Ctx {
	readonly found: ReadonlySet<string>;
	readonly root: string;
}

const NONE: Ctx = { found: new Set(), root: "" };

/** Prose with each confirmed path as a chip. */
function prose(text: string, ctx: Ctx): ReactNode {
	const hits = ctx.found.size === 0 ? [] : pathsIn(text, ctx.root).filter((h) => ctx.found.has(h.path));
	if (hits.length === 0) return text;
	const out: ReactNode[] = [];
	let from = 0;
	for (const h of hits) {
		out.push(text.slice(from, h.at), <Chip key={h.at} path={h.path} />);
		from = h.at + h.raw.length;
	}
	out.push(text.slice(from));
	return out;
}

function inlines(nodes: readonly Inline[], ctx: Ctx): ReactNode[] {
	return nodes.map((n, i) => {
		switch (n.t) {
			case "text":
				return <Fragment key={i}>{prose(n.text, ctx)}</Fragment>;
			case "b":
				return <b key={i}>{inlines(n.children, ctx)}</b>;
			case "i":
				return <em key={i}>{inlines(n.children, ctx)}</em>;
			case "s":
				return <s key={i}>{inlines(n.children, ctx)}</s>;
			case "code": {
				const path = pathish(n.text, ctx.root);
				return path !== null && ctx.found.has(path) ? <Chip key={i} path={path} /> : <code key={i}>{n.text}</code>;
			}
			case "link":
				return <Link key={i} text={n.text} href={n.href} found={ctx.found} root={ctx.root} />;
		}
	});
}

/** The paths a block's prose, inline code and links name: what /desk/exists is asked about. Never a code block's. */
function candidates(blocks: readonly Block[], root: string): string[] {
	const out: string[] = [];
	const walk = (nodes: readonly Inline[]): void => {
		for (const n of nodes) {
			if (n.t === "text") out.push(...pathsIn(n.text, root).map((h) => h.path));
			else if (n.t === "code" || n.t === "link") {
				const p = pathish(n.t === "code" ? n.text : n.href, root);
				if (p !== null) out.push(p);
			} else walk(n.children);
		}
	};
	for (const b of blocks) {
		if (b.t === "h" || b.t === "p") walk(b.inline);
		else if (b.t === "ul" || b.t === "ol") b.items.forEach(walk);
		else if (b.t === "table") [...b.head, ...b.rows.flat()].forEach(walk);
		else if (b.t === "quote") out.push(...candidates(b.children, root));
	}
	return out;
}

function block(b: Block, i: number, ctx: Ctx = NONE): ReactNode {
	switch (b.t) {
		case "h":
			return b.level === 1 ? <h1 key={i}>{inlines(b.inline, ctx)}</h1> : b.level === 2 ? <h2 key={i}>{inlines(b.inline, ctx)}</h2> : <h3 key={i}>{inlines(b.inline, ctx)}</h3>;
		case "p":
			return <p key={i}>{inlines(b.inline, ctx)}</p>;
		case "ul":
			return (
				<ul key={i}>
					{b.items.map((it, j) => (
						<li key={j}>{inlines(it, ctx)}</li>
					))}
				</ul>
			);
		case "ol":
			return (
				<ol key={i}>
					{b.items.map((it, j) => (
						<li key={j}>{inlines(it, ctx)}</li>
					))}
				</ol>
			);
		case "code":
			return (
				<pre key={i}>
					<code>{b.text}</code>
				</pre>
			);
		case "table":
			// a wide table scrolls inside its own box; the page never scrolls sideways
			return (
				<div key={i} className="tbl" data-kind="table">
					<table>
						<thead>
							<tr>
								{b.head.map((c, j) => (
									<th key={j} style={{ textAlign: b.align[j] ?? undefined }}>
										{inlines(c, ctx)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{b.rows.map((row, r) => (
								<tr key={r}>
									{row.map((c, j) => (
										<td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
											{inlines(c, ctx)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "quote":
			return <blockquote key={i}>{b.children.map((c, j) => block(c, j, ctx))}</blockquote>;
		case "hr":
			return <hr key={i} />;
	}
}

/** Markdown drawn from a tree, without the answer's frame (the file preview uses it). */
export function Markdown({ text }: { readonly text: string }): ReactNode {
	return <>{render(text, false).map((b, i) => block(b, i))}</>;
}

/** At most this many characters appear in one frame, however large the delta that brought them. */
export const STEADY_CAP = 24;

/**
 * Streamed text released at a steady pace: what arrives is buffered and shown a little each frame (an eighth of what is behind, at
 * least 2 and at most STEADY_CAP characters, ending on a word where one ends close by), so a burst of deltas reads as an even flow.
 * Text already there when it mounts (a replay, a reopened page) is shown whole at once; a shrink (a voided draft) is followed at once.
 */
function useSteady(text: string): string {
	const [shown, setShown] = useState(text);
	const goal = useRef(text);
	goal.current = text;
	const behind = shown !== text;
	useEffect(() => {
		if (!behind) return;
		let id = requestAnimationFrame(function tick() {
			setShown((prev) => {
				const target = goal.current;
				if (!target.startsWith(prev)) return target;
				const step = Math.min(STEADY_CAP, Math.max(2, Math.ceil((target.length - prev.length) / 8)));
				let end = Math.min(target.length, prev.length + step);
				const space = target.indexOf(" ", end);
				if (space !== -1 && space + 1 - prev.length <= STEADY_CAP) end = space + 1;
				return target.slice(0, end);
			});
			id = requestAnimationFrame(tick);
		});
		return () => cancelAnimationFrame(id);
	}, [behind]);
	return behind && !text.startsWith(shown) ? text : shown;
}

/** Markdown that may still be streaming: released steadily, unclosed markers and unfinished rows held back until whole. */
export function Blocks({ text, live, className, kind, onSettled }: { readonly text: string; readonly live: boolean; readonly className: string; readonly kind: string; readonly onSettled?: (drawn: boolean) => void }): ReactNode {
	const shown = useSteady(text);
	const settled = shown === text;
	useEffect(() => onSettled?.(settled && !live), [settled, live, onSettled]);
	const root = useContext(RootContext);
	const blocks = render(shown, live || !settled);
	// a finished block asks once which of its paths are files; until then they are text
	const found = useFound(settled && !live ? candidates(blocks, root) : [], settled && !live);
	const ctx: Ctx = { found, root };
	return (
		<div className={`${className}${live || !settled ? " caret" : ""}`} data-kind={kind} data-settled={settled && !live}>
			{blocks.map((b, i) => block(b, i, ctx))}
		</div>
	);
}

/** The answer: markdown drawn from a tree, released steadily, with unclosed markers held back while it streams. */
export const Answer = ({ text, live, onSettled }: { readonly text: string; readonly live: boolean; readonly onSettled?: (drawn: boolean) => void }): ReactNode => <Blocks className="ans" kind="answer" text={text} live={live} {...(onSettled !== undefined ? { onSettled } : {})} />;
