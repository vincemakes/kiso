import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, span, t } from "../i18n/index.js";
import type { Thinking as ThinkingItem } from "../state/model.js";
import { Chevron, Spark } from "./Icons.js";
import { useNow } from "./useNow.js";

/**
 * Thinking: one line that pages to the first sentence of each paragraph as
 * it is written, opens to the full text, and ends as "Thought for N s".
 */
export function Thinking({ item }: { readonly item: ThinkingItem }): ReactNode {
	const live = item.endedAt === null;
	const [open, setOpen] = useState(false);
	const now = useNow(live);
	const started = item.startedAt ?? now;
	const elapsed = (item.endedAt ?? now) - started;
	const latest = item.lines.length > 0 ? item.lines[item.lines.length - 1]! : "";
	// the line before this one leaves upward while the new one arrives
	const shown = useRef("");
	const [leaving, setLeaving] = useState("");
	useEffect(() => {
		if (latest === shown.current) return;
		if (shown.current !== "") {
			setLeaving(shown.current);
			const id = setTimeout(() => setLeaving(""), 350);
			shown.current = latest;
			return () => clearTimeout(id);
		}
		shown.current = latest;
	}, [latest]);
	return (
		<div className={`think ${live ? "thinking" : "done"}${open ? " open" : ""}`} data-kind="thinking">
			<button className="th-h" onClick={() => setOpen(!open)} aria-expanded={open}>
				<Chevron />
				<Spark />
				<span className={`lab${live ? " shimmer" : ""}`}>{live ? t.thinking : fmt(t.thought, { time: span(Math.max(1000, elapsed)) })}</span>
				{live ? <span className="t">{Math.round(elapsed / 1000)}s</span> : null}
				<span className="pv1">
					{leaving !== "" ? <span className="out">{leaving}</span> : null}
					{latest !== "" ? (
						<span key={latest} className="on">
							{latest}
						</span>
					) : null}
				</span>
			</button>
			<div className="th-full">
				<div>
					<div className="th-text">{item.text.trim()}</div>
				</div>
			</div>
		</div>
	);
}
