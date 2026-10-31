import type { ReactNode } from "react";
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
	}
}

/** Markdown drawn from a tree, without the answer's frame (the file preview uses it). */
export function Markdown({ text }: { readonly text: string }): ReactNode {
	return <>{render(text, false).map(block)}</>;
}

/** The answer: markdown drawn from a tree, with unclosed markers held back while it streams. */
export function Answer({ text, live }: { readonly text: string; readonly live: boolean }): ReactNode {
	return (
		<div className={`ans${live ? " caret" : ""}`} data-kind="answer">
			{render(text, live).map(block)}
		</div>
	);
}
