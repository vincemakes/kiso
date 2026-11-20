import { useState, type MouseEvent, type ReactNode } from "react";

/** Finding #3: a sidebar row whose title is cut shows the whole title in a tooltip under the row; a title that fits shows none. */
export function useRowTip(): { readonly on: (e: MouseEvent<HTMLElement>) => void; readonly off: () => void; readonly tip: ReactNode } {
	const [at, setAt] = useState<{ readonly text: string; readonly top: number; readonly left: number } | null>(null);
	const on = (e: MouseEvent<HTMLElement>): void => {
		const row = e.currentTarget;
		// measured a frame later, after the hover rule has made room for the row's ⋯
		requestAnimationFrame(() => {
			const tt = row.querySelector(".tt");
			const r = row.getBoundingClientRect();
			setAt(tt !== null && tt.scrollWidth > tt.clientWidth ? { text: tt.textContent ?? "", top: r.bottom + 4, left: r.left + 10 } : null);
		});
	};
	const tip = at === null ? null : (
		<div className="row-tip" role="tooltip" data-kind="row-tip" style={{ top: at.top, left: at.left }}>
			{at.text}
		</div>
	);
	return { on, off: () => setAt(null), tip };
}
