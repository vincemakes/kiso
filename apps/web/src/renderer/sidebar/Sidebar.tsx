import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import { groupWorks } from "../state/works.js";
import type { WorkRow } from "../../shared/history.js";
import { Chevron, Plus, Sliders } from "../stream/Icons.js";
import { Dialog } from "../rail/GitDialogs.js";

export type WorkAct = "pin" | "unpin" | "archive" | "unarchive" | "delete";

interface Props {
	readonly works: readonly WorkRow[];
	/** the open Work: row identity is the folder's key (null: the folder in use) and the session id */
	readonly active: { readonly key: string; readonly id: string } | null;
	readonly settingsOn: boolean;
	readonly onOpen: (row: WorkRow) => void;
	readonly onNew: () => void;
	readonly onSettings: () => void;
	/** a row's menu: each refusal comes back in words */
	readonly onAct: (row: WorkRow, act: WorkAct) => Promise<void>;
	readonly onRename: (row: WorkRow, name: string) => Promise<void>;
	readonly onFork: (row: WorkRow) => void;
	/** the open pull request of the row's folder branch, read when its menu opens */
	readonly prOf: (row: WorkRow) => Promise<{ readonly number: number; readonly url: string } | null>;
}

const svg = (d: ReactNode): ReactNode => (
	<svg className="ico" viewBox="0 0 24 24">
		{d}
	</svg>
);
/** The menu's items in order, each with its key (pressed while the menu is open); null draws a line. */
const KEYS = { pr: "G", pin: "P", unpin: "P", rename: "R", fork: "F", archive: "A", unarchive: "A", delete: "D" } as const;
type Pick = keyof typeof KEYS;

/** A row's ⋯ menu, laid over the window at the key (the list scrolls, the menu does not clip): a click away or Esc closes it, a
 *  letter picks. */
function WorkMenu({ row, at, onClose, onPick, prOf }: { readonly row: WorkRow; readonly at: DOMRect; readonly onClose: () => void; readonly onPick: (what: Pick, pr?: string) => void; readonly prOf: Props["prOf"] }): ReactNode {
	const box = useRef<HTMLDivElement>(null);
	const [pr, setPr] = useState<{ readonly number: number; readonly url: string } | null>(null);
	useEffect(() => void prOf(row).then(setPr, () => undefined), [row, prOf]);
	const items: (readonly [Pick, string, boolean?] | null)[] = [
		...(pr !== null ? [["pr", fmt(t.openPr, { n: pr.number })] as const, null] : []),
		row.pinned !== undefined ? ["unpin", t.unpin] : ["pin", t.pin],
		["rename", t.rename],
		...(row.runs > 0 ? [["fork", t.fork] as const] : []),
		null,
		row.archived === true ? ["unarchive", t.unarchive] : ["archive", t.archive],
		["delete", t.deleteWork, true],
	];
	useEffect(() => {
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) === false && onClose());
		const key = (e: KeyboardEvent): void => {
			if (e.key === "Escape") return onClose();
			const hit = e.metaKey || e.ctrlKey || e.altKey ? undefined : items.find((it) => it !== null && KEYS[it[0]] === e.key.toUpperCase());
			if (hit) (e.preventDefault(), onPick(hit[0], pr?.url));
		};
		addEventListener("mousedown", away);
		addEventListener("keydown", key);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
	});
	return (
		<div ref={box} className="menu smenu" data-kind="work-menu" style={{ top: Math.min(at.bottom + 2, innerHeight - 290), left: at.right - 34 }}>
			{items.map((it, i) =>
				it === null ? (
					<div key={i} className="sep" />
				) : (
					<button key={it[0]} className={it[2] === true ? "danger" : ""} data-menu-act={it[0]} onClick={() => onPick(it[0], pr?.url)}>
						{it[1]}
						<kbd>{KEYS[it[0]]}</kbd>
					</button>
				),
			)}
		</div>
	);
}

/** Which groups are folded, kept per browser (a convenience: it reads back empty when storage is not there). */
const FOLDS = "kiso.web.folds";
const foldsRead = (): string[] => {
	try {
		return JSON.parse(localStorage.getItem(FOLDS) ?? "[]") as string[];
	} catch {
		return [];
	}
};

/** The history: pinned first, then by day; a row's ⋯ menu; the Archived line; the Functions fold at the bottom (v1: Settings). */
export function Sidebar({ works, active, settingsOn, onOpen, onNew, onSettings, onAct, onRename, onFork, prOf }: Props): ReactNode {
	const [fnOpen, setFnOpen] = useState(false);
	const [menu, setMenu] = useState<{ readonly row: WorkRow; readonly at: DOMRect } | null>(null);
	const [renaming, setRenaming] = useState<WorkRow | null>(null);
	const [draft, setDraft] = useState("");
	const [deleting, setDeleting] = useState<WorkRow | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const [folds, setFolds] = useState<readonly string[]>(foldsRead);
	const fold = (label: string): void => {
		const next = folds.includes(label) ? folds.filter((f) => f !== label) : [...folds, label];
		setFolds(next);
		try {
			localStorage.setItem(FOLDS, JSON.stringify(next));
		} catch {}
	};
	const box = useRef<HTMLInputElement>(null);
	const same = (a: WorkRow | null, b: WorkRow): boolean => a !== null && a.key === b.key && a.id === b.id;
	const act = (row: WorkRow, what: WorkAct): void => void onAct(row, what).then(() => setError(null), (e: Error) => setError(e.message));
	const pick = (row: WorkRow, what: Pick, pr?: string): void => {
		setMenu(null);
		if (what === "rename") {
			setDraft(row.title);
			setRenaming(row);
			requestAnimationFrame(() => box.current?.select());
		} else if (what === "fork") onFork(row);
		else if (what === "pr") open(pr, "_blank", "noopener");
		else if (what === "delete") (setError(null), setDeleting(row));
		else act(row, what);
	};
	const keep = (row: WorkRow): void => {
		setRenaming(null);
		if (draft.trim() !== row.title) void onRename(row, draft);
	};
	const rowOf = (row: WorkRow, className: string): ReactNode => (
		<div key={`${row.key}/${row.id}`} className={`row${same(menu?.row ?? null, row) ? " menu-open" : ""}`}>
			{same(renaming, row) ? (
				<div className={`item ${className}`}>
					<input
						ref={box}
						className="row-in"
						value={draft}
						maxLength={120}
						aria-label={t.renameWork}
						data-field="row-title-input"
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) keep(row);
							else if (e.key === "Escape") setRenaming(null);
						}}
						onBlur={() => setRenaming(null)}
					/>
				</div>
			) : (
				<button className={`item ${className}${active?.key === row.key && active.id === row.id ? " on" : ""}`} onClick={() => onOpen(row)} data-work={row.id} data-state={row.state}>
					{row.state === "running" ? <span className="sp" title={t.runningNow} /> : row.state === "waiting" ? <span className="dot amber" title={t.waitingForYou} /> : null}
					<span className="tt">{row.title === "" ? t.untitled : row.title}</span>
					<small>{row.folder}</small>
				</button>
			)}
			{same(renaming, row) ? null : (
				<button className="dots" aria-label={t.workMenu} data-act="work-menu" data-for={row.id} onClick={(e) => setMenu(same(menu?.row ?? null, row) ? null : { row, at: e.currentTarget.closest(".row")!.getBoundingClientRect() })}>
					{svg(<><circle cx="5.5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="18.5" cy="12" r="1.2" /></>)}
				</button>
			)}
		</div>
	);
	const archived = works.filter((w) => w.archived === true);
	return (
		<aside className="side" data-kind="sidebar">
			<div className="side-in">
			<button className="newbtn" onClick={onNew} data-act="new">
				<Plus />
				{t.newTask}
			</button>
			<div className="hlist">
				{error !== null && deleting === null ? <div className="side-err" data-kind="work-error">{error}</div> : null}
				{groupWorks(works).map((group) => (
					<section key={group.label} className={folds.includes(group.label) ? "shut" : ""}>
						<button className="grp gh" onClick={() => fold(group.label)} aria-expanded={!folds.includes(group.label)} data-act="fold-group">
							{group.label}
							<svg className="tri" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M6 9h12l-6 7z" />
							</svg>
						</button>
						{folds.includes(group.label) ? null : group.works.map((row, i) => rowOf(row, row.parent !== undefined && row.pinned === undefined && group.works.some((w) => w.key === row.key && w.id === row.parent) ? (group.works[i + 1]?.parent === row.parent ? "child more" : "child") : ""))}
					</section>
				))}
				{archived.length > 0 ? (
					<section>
						<button className="grp archived-h" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived} data-act="archived">
							{fmt(t.archivedN, { n: archived.length })}
						</button>
						{showArchived ? archived.map((row) => rowOf(row, "")) : null}
					</section>
				) : null}
			</div>
			{menu !== null ? <WorkMenu row={menu.row} at={menu.at} onClose={() => setMenu(null)} onPick={(what, pr) => pick(menu.row, what, pr)} prOf={prOf} /> : null}
			{deleting !== null ? (
				<Dialog
					kind="delete"
					title={fmt(t.deleteTitle, { title: deleting.title === "" ? t.untitled : deleting.title })}
					sub={deleting.folder}
					busy={busy}
					error={error}
					confirm={t.deleteConfirm}
					danger
					onCancel={() => setDeleting(null)}
					onConfirm={() => {
						setBusy(true);
						void onAct(deleting, "delete").then(
							() => (setBusy(false), setDeleting(null), setError(null)),
							(e: Error) => (setBusy(false), setError(e.message)),
						);
					}}
				>
					<p className="dlg-p" data-kind="delete-what">{fmt(t.deleteWhat, { runs: deleting.runs === 1 ? t.oneRun : fmt(t.nRuns, { n: deleting.runs }) })}</p>
				</Dialog>
			) : null}
			<div className={`fn${fnOpen ? " open" : ""}`}>
				<button className="fn-h" onClick={() => setFnOpen(!fnOpen)} aria-expanded={fnOpen}>
					{t.functions}
					<span className="chev">
						<Chevron />
					</span>
				</button>
				<div className="fn-b">
					<div>
						<button className={settingsOn ? "on" : ""} onClick={onSettings} data-act="settings">
							<Sliders />
							{t.settings}
						</button>
					</div>
				</div>
			</div>
			</div>
		</aside>
	);
}
