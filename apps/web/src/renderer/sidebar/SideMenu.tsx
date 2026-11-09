import { useEffect, useRef, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import type { SideBy, SideSort } from "../state/works.js";
import { Check } from "../stream/Icons.js";

/** How the sidebar lists Recents, kept per browser (a convenience: by folder, by last update when storage is not there). */
export interface View {
	readonly by: SideBy;
	readonly sort: SideSort;
}
export const VIEW = "kiso.web.side-view";
export const viewRead = (): View => {
	try {
		const v = JSON.parse(localStorage.getItem(VIEW) ?? "{}") as Partial<View>;
		return { by: v.by === "list" ? "list" : "folder", sort: v.sort === "created" ? "created" : "updated" };
	} catch {
		return { by: "folder", sort: "updated" };
	}
};

/** The Recents ⋯ menu: how Recents is organized and sorted; a click away or Esc closes it. */
export function SideMenu({ at, view, onPick, onClose }: { readonly at: DOMRect; readonly view: View; readonly onPick: (view: View) => void; readonly onClose: () => void }): ReactNode {
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) === false && (e.target as Element).closest?.("[data-act=side-menu]") === null && onClose());
		const key = (e: KeyboardEvent): void => void (e.key === "Escape" && onClose());
		addEventListener("mousedown", away);
		addEventListener("keydown", key);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
	});
	const item = (on: boolean, label: string, act: string, next: Partial<View>): ReactNode => (
		<button key={act} role="menuitemradio" aria-checked={on} data-menu-act={act} onClick={() => onPick({ ...view, ...next })}>
			{label}
			<span className="ck">{on ? <Check /> : null}</span>
		</button>
	);
	return (
		<div ref={box} className="menu smenu" data-kind="side-menu" style={{ top: at.bottom + 2, left: Math.max(8, at.right - 206) }}>
			<div className="mh">{t.organize}</div>
			{item(view.by === "folder", t.byFolder, "by-folder", { by: "folder" })}
			{item(view.by === "list", t.oneList, "one-list", { by: "list" })}
			<div className="sep" />
			<div className="mh">{t.sortBy}</div>
			{item(view.sort === "updated", t.lastUpdated, "sort-updated", { sort: "updated" })}
			{item(view.sort === "created", t.createdAt, "sort-created", { sort: "created" })}
		</div>
	);
}
