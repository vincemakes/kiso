import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** What a hover shows: the name (at most three lines) and one line of what it is doing. */
export interface TipData {
	readonly title: string;
	readonly meta: string;
}

/**
 * The hover card, dark and small, to the left of the rail beside the row that asked for it (owner 2026-11-25): placed at the row's
 * top and moved up as far as it must so the whole card stays in the window, measured before it paints.
 */
export function Tip({ tip, at }: { readonly tip: TipData | null; readonly at: number }): ReactNode {
	const box = useRef<HTMLDivElement>(null);
	const [top, setTop] = useState<number | null>(null);
	useLayoutEffect(() => setTop(Math.max(8, Math.min(at - 6, innerHeight - (box.current?.offsetHeight ?? 0) - 8))), [tip, at]);
	if (tip === null) return null;
	return (
		<div ref={box} className="tip show" style={{ top: top ?? at, visibility: top === null ? "hidden" : undefined }} data-kind="tip">
			<div className="ttl" data-field="tip-title">{tip.title}</div>
			<div className="meta" data-field="tip-meta">{tip.meta}</div>
		</div>
	);
}
