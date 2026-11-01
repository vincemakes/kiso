import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import type { PanelKind } from "../state/panels.js";

const ITEMS: readonly { readonly kind: PanelKind; readonly label: string; readonly icon: ReactNode }[] = [
	{ kind: "term", label: t.panelTerm, icon: <path d="m5 8 5 4-5 4M12 17h7" /> },
	{ kind: "diff", label: t.panelDiff, icon: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v6M9 11h6M9 16h6" /></> },
	{ kind: "web", label: t.panelWeb, icon: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5M12 3.5C9.5 5.9 8.4 8.7 8.4 12s1.1 6.1 3.6 8.5" /></> },
	{ kind: "files", label: t.panelFiles, icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /> },
];

/** The ⋮ key beside the overview key, and the list of panels it opens. */
export function PanelMenu({ onPick }: { readonly onPick: (kind: PanelKind) => void }): ReactNode {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		if (!open) return;
		const close = (): void => setOpen(false);
		addEventListener("click", close);
		return () => removeEventListener("click", close);
	}, [open]);
	return (
		<>
			<button
				className="morebtn"
				aria-label={t.panelMore}
				aria-expanded={open}
				data-act="panel-menu"
				onClick={(e) => {
					e.stopPropagation();
					setOpen(!open);
				}}
			>
				<svg className="ico" viewBox="0 0 24 24">
					<circle cx="12" cy="5.5" r="1.2" />
					<circle cx="12" cy="12" r="1.2" />
					<circle cx="12" cy="18.5" r="1.2" />
				</svg>
			</button>
			{open ? (
				<div className="menu" data-kind="panel-menu">
					{ITEMS.map((i) => (
						<button key={i.kind} onClick={() => onPick(i.kind)} data-open={i.kind}>
							<svg className="ico" viewBox="0 0 24 24">
								{i.icon}
							</svg>
							{i.label}
						</button>
					))}
				</div>
			) : null}
		</>
	);
}
