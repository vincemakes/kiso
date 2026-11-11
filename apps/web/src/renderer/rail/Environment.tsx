import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EnvReply } from "../../shared/settings.js";
import { fmt, t } from "../i18n/index.js";
import { changeWorkFolders, openRow, Refusal } from "../state/desk.js";
import { noteFolders } from "../state/envnote.js";
import { addFolderTo } from "../state/folders.js";
import { I } from "../stream/Icons.js";

/** One row of the card and what its menu offers (a click or a right-click opens it; there is no hover mark). */
interface Item {
	readonly key: string;
	readonly icon: ReactNode;
	readonly name: string;
	readonly sub?: string;
	readonly mono?: boolean;
	readonly acts: readonly (readonly [string, () => void])[];
}
const SHOWN = 3;
const copy = (text: string): void => void navigator.clipboard?.writeText(text).catch(() => undefined);

/** The Environment card's folder, branch and repository rows (the primary and added folders grant access; recent folders and repositories only record). */
export function Environment({ env, where, session, onChanged }: { readonly env: EnvReply; readonly where: string | null; readonly session: string; readonly onChanged: () => void }): ReactNode {
	const [menu, setMenu] = useState<{ readonly key: string; readonly at: DOMRect } | null>(null);
	const [more, setMore] = useState<readonly string[]>([]);
	const [err, setErr] = useState<string | null>(null);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (menu === null) return;
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) === false && setMenu(null));
		const key = (e: KeyboardEvent): void => void (e.key === "Escape" && setMenu(null));
		addEventListener("mousedown", away);
		addEventListener("keydown", key);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
	}, [menu]);
	const rows = env.rows;
	if (rows === undefined) return null;
	const change = (change: { readonly add: string } | { readonly remove: string }): void => void changeWorkFolders(where, session, change).then(() => (noteFolders(session, "add" in change ? `added ${change.add}. Use absolute paths there.` : `removed ${change.remove}.`), setErr(null), onChanged()), (e: unknown) => setErr(e instanceof Refusal ? e.message : String(e)));
	const add = (): void => void addFolderTo(where, session).then((m) => (setErr(m), onChanged()));
	const door = (name: "reveal" | "terminal", i: number): readonly (readonly [string, () => void])[] => (rows.doors.includes(name) ? [[name === "reveal" ? t.envReveal : t.envTerminal, () => void openRow(where, session, i, name, rows.folders[i]!.path)]] : []);
	const gh = (repo: string | null): readonly (readonly [string, () => void])[] => (repo === null ? [] : [[t.envGithub, () => void window.open(`https://github.com/${repo}`, "_blank", "noopener")]]);
	const folders: Item[] = rows.folders.map((f, i) => ({
		key: `f${i}`,
		icon: <I.folder />,
		name: f.path.slice(f.path.lastIndexOf("/") + 1) || "/",
		sub: f.missing ? ` · ${t.envMissing}` : ` · ${f.shown.slice(0, f.shown.lastIndexOf("/")) || "/"}`,
		acts: [...door("reveal", i), ...gh(f.github), [t.envCopyPath, () => copy(f.path)], ...(f.kind === "primary" ? ([[t.envAddFolder, add]] as const) : []), ...door("terminal", i), ...(f.kind === "added" ? ([[t.envRemove, () => change({ remove: f.path })]] as const) : f.kind === "recent" && f.addable === true ? ([[t.envAddHere, () => change({ add: f.path })]] as const) : [])],
	}));
	const branchOf = (i: number): Item[] => (rows.folders[i]!.branch === null ? [] : [{ key: `b${i}`, icon: <I.branch />, name: rows.folders[i]!.branch!, mono: true, acts: [[t.envCopyBranch, () => copy(rows.folders[i]!.branch!)]] }]);
	const repos: Item[] = rows.repos.map((r) => ({ key: `r${r.url}`, icon: <I.pr />, name: r.repo, sub: ` · #${r.number}`, acts: [...gh(r.repo), [t.envCopyName, () => copy(r.repo)], ...(r.branch === undefined ? [] : ([[t.envCopyBranch, () => copy(r.branch!)]] as const))] }));
	const group = (id: string, head: string | null, items: readonly Item[]): ReactNode =>
		items.length === 0 ? null : (
			<div className="r-grp" data-group={id}>
				{head === null ? null : <div className="r-gh">{head}</div>}
				{(more.includes(id) ? items : items.slice(0, SHOWN)).map(row)}
				{items.length > SHOWN && !more.includes(id) ? (
					<button className="r-more" onClick={() => setMore([...more, id])}>
						{fmt(t.railShowMore, { n: items.length - SHOWN })}
					</button>
				) : null}
			</div>
		);
	const row = (it: Item): ReactNode => (
		<button key={it.key} className="r-row" data-env-row={it.key} onClick={(e) => setMenu({ key: it.key, at: e.currentTarget.getBoundingClientRect() })} onContextMenu={(e) => (e.preventDefault(), setMenu({ key: it.key, at: e.currentTarget.getBoundingClientRect() }))}>
			<span className="r-ic">{it.icon}</span>
			<span className={`r-nm${it.mono === true ? " mono" : ""}`}>
				{it.name}
				{it.sub === undefined ? null : <span className="r-sub">{it.sub}</span>}
			</span>
		</button>
	);
	const kind = (k: string): number[] => rows.folders.flatMap((f, i) => (f.kind === k ? [i] : []));
	const withBranch = (idx: number[]): Item[] => idx.flatMap((i) => [folders[i]!, ...branchOf(i)]);
	const open = [...folders, ...rows.folders.flatMap((_, i) => branchOf(i)), ...repos].find((it) => it.key === menu?.key);
	return (
		<>
			{group("primary", null, withBranch(kind("primary")))}
			{group("added", t.envAdded, withBranch(kind("added")))}
			{group("recent", t.envRecent, kind("recent").map((i) => folders[i]!))}
			{group("repos", t.envRepos, repos)}
			{rows.damaged ? <div className="r-note" data-field="env-damaged">{t.envDamaged}</div> : null}
			{err === null ? null : <div className="r-note err" data-field="env-error">{err}</div>}
			{menu === null || open === undefined ? null : (
				<div ref={box} className="menu smenu" data-kind="env-menu" style={{ top: menu.at.bottom + 2, left: Math.max(8, Math.min(menu.at.left, innerWidth - 216)) }}>
					{open.acts.map(([label, run]) => (
						<button key={label} data-menu-act={label} onClick={() => (setMenu(null), run())}>
							{label}
						</button>
					))}
				</div>
			)}
		</>
	);
}
