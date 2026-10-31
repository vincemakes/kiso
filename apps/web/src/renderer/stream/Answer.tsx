import { useEffect, useRef, useState, type ReactNode } from "react";
import { render, type Block, type Inline } from "../state/markdown.js";

function inlines(nodes: readonly Inline[]): ReactNode[] {
	return nodes.map((n, i) => {
		switch (n.t) {
			case "text":
				return n.text;
			case "b":
				return <b key={i}>{inlines(n.children)}</b>;
			case "i":
				return <em key={i}>{inlines(n.children)}</em>;
			case "s":
				return <s key={i}>{inlines(n.children)}</s>;
			case "code":
				return <code key={i}>{n.text}</code>;
			case "link":
				// shown as a link, never navigated to from the stream (S5 opens links in the browser)
				return (
					<span key={i} className="lk" title={n.href}>
						{n.text}
					</span>
				);
		}
	});
}

function block(b: Block, i: number): ReactNode {
	switch (b.t) {
		case "h":
			return b.level === 1 ? <h1 key={i}>{inlines(b.inline)}</h1> : b.level === 2 ? <h2 key={i}>{inlines(b.inline)}</h2> : <h3 key={i}>{inlines(b.inline)}</h3>;
		case "p":
			return <p key={i}>{inlines(b.inline)}</p>;
		case "ul":
			return (
				<ul key={i}>
					{b.items.map((it, j) => (
						<li key={j}>{inlines(it)}</li>
					))}
				</ul>
			);
		case "ol":
			return (
				<ol key={i}>
					{b.items.map((it, j) => (
						<li key={j}>{inlines(it)}</li>
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
										{inlines(c)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{b.rows.map((row, r) => (
								<tr key={r}>
									{row.map((c, j) => (
										<td key={j} style={{ textAlign: b.align[j] ?? undefined }}>
											{inlines(c)}
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "quote":
			return <blockquote key={i}>{b.children.map(block)}</blockquote>;
		case "hr":
			return <hr key={i} />;
	}
}

/** Markdown drawn from a tree, without the answer's frame (the file preview uses it). */
export function Markdown({ text }: { readonly text: string }): ReactNode {
	return <>{render(text, false).map(block)}</>;
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
export function Blocks({ text, live, className, kind }: { readonly text: string; readonly live: boolean; readonly className: string; readonly kind: string }): ReactNode {
	const shown = useSteady(text);
	const settled = shown === text;
	return (
		<div className={`${className}${live || !settled ? " caret" : ""}`} data-kind={kind} data-settled={settled && !live}>
			{render(shown, live || !settled).map(block)}
		</div>
	);
}

/** The answer: markdown drawn from a tree, released steadily, with unclosed markers held back while it streams. */
export const Answer = ({ text, live }: { readonly text: string; readonly live: boolean }): ReactNode => <Blocks className="ans" kind="answer" text={text} live={live} />;
