import { useState, type ReactNode } from "react";
import { fmt, span, t } from "../i18n/index.js";
import type { Thinking as ThinkingItem } from "../state/model.js";
import { Chevron } from "./Icons.js";
import { useNow } from "./useNow.js";

/**
 * Thinking: one folded row, "Thinking" and its seconds while it runs, "Thought for N s" after; it opens to the full text. The row
 * carries none of the text (owner 2026-11-03: the paging preview line overlapped the next row; this reverses the preview). No icon: a
 * static sparkle read as "still loading" (owner 2026-11-04); the chevron follows the label.
 */
export function Thinking({ item }: { readonly item: ThinkingItem }): ReactNode {
	const live = item.endedAt === null;
	const [open, setOpen] = useState(false);
	const now = useNow(live);
	const started = item.startedAt ?? now;
	const elapsed = (item.endedAt ?? now) - started;
	return (
		<div className={`think ${live ? "thinking" : "done"}${open ? " open" : ""}`} data-kind="thinking">
			<button className="th-h" onClick={() => setOpen(!open)} aria-expanded={open}>
				<span className={`lab${live ? " shimmer" : ""}`}>{live ? t.thinking : fmt(t.thought, { time: span(Math.max(1000, elapsed)) })}</span>
				{live ? <span className="t">{Math.round(elapsed / 1000)}s</span> : null}
				<Chevron />
			</button>
			<div className="th-full">
				<div>
					<div className="th-text">{item.text.trim()}</div>
				</div>
			</div>
		</div>
	);
}
