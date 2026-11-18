import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { byPerson } from "./blur.js";

interface Props {
	/** the Work's name, else its first-request title */
	readonly title: string;
	readonly onRename: (name: string) => Promise<void>;
	/** the overview key and the panel menu, at the conversation's top right */
	readonly children: ReactNode;
}

/**
 * The conversation's header: its title (a click selects it for typing over, in place, with no box: Enter keeps it, Esc or a click
 * away leaves it as it was, an empty name goes back to the first-request title), and at the right the
 * overview key and the panel menu, which stay there whether the rail is open, closed or given way to a panel.
 */
export function Header({ title, onRename, children }: Props): ReactNode {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	const box = useRef<HTMLInputElement>(null);
	const live = useRef(false);
	const [err, setErr] = useState<string | null>(null);
	const start = (): void => {
		setDraft(title);
		setEditing((live.current = true));
	};
	// focused and selected before the next paint, so what is typed right after the click replaces the name (a frame callback came late, or never in a hidden window)
	useLayoutEffect(() => void (editing && (box.current?.focus(), box.current?.select())), [editing]);
	// Enter and a click away both save (once: the box is gone after the first); Esc leaves it as it was; a blur with nothing typed saves nothing
	const keep = (blur = false): void => {
		if (!live.current) return;
		setEditing((live.current = false));
		if (draft.trim() !== title && !(blur && draft.trim() === "")) void onRename(draft).then(() => setErr(null), (e: Error) => setErr(e.message));
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
						else if (e.key === "Escape") setEditing((live.current = false));
					}}
					onBlur={() => (byPerson() ? keep(true) : box.current?.focus())}
				/>
			) : (
				<button className="hdr-title" onClick={start} title={t.renameWork} data-field="title">
					{title}
				</button>
			)}
			{err === null ? null : <span className="hdr-err" data-field="title-error" role="alert">{err}</span>}
			<span className="grow" />
			{children}
		</header>
	);
}
