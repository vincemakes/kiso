import { useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";

interface Props {
	/** the Work's name, else its first-request title */
	readonly title: string;
	/** folder · branch */
	readonly sub: string;
	readonly onRename: (name: string) => Promise<void>;
	/** the overview key and the panel menu, at the conversation's top right */
	readonly children: ReactNode;
}

/**
 * The conversation's header: its title (a click selects it for typing over, in place, with no box: Enter keeps it, Esc or a click
 * away leaves it as it was, an empty name goes back to the first-request title), the folder and branch, and at the right the
 * overview key and the panel menu, which stay there whether the rail is open, closed or given way to a panel.
 */
export function Header({ title, sub, onRename, children }: Props): ReactNode {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	const box = useRef<HTMLInputElement>(null);
	const start = (): void => {
		setDraft(title);
		setEditing(true);
		requestAnimationFrame(() => box.current?.select());
	};
	const keep = (): void => {
		setEditing(false);
		if (draft.trim() !== title) void onRename(draft);
	};
	return (
		<header className="hdr" data-kind="header">
			{editing ? (
				<input
					ref={box}
					className="hdr-title edit"
					value={draft}
					maxLength={120}
					aria-label={t.renameWork}
					data-field="title-input"
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.nativeEvent.isComposing) keep();
						else if (e.key === "Escape") setEditing(false);
					}}
					onBlur={() => setEditing(false)}
				/>
			) : (
				<button className="hdr-title" onClick={start} title={t.renameWork} data-field="title">
					{title}
				</button>
			)}
			{editing || sub === "" ? null : (
				<span className="hdr-sub" data-field="title-sub">
					{sub}
				</span>
			)}
			<span className="grow" />
			{children}
		</header>
	);
}
