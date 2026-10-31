import { useEffect, useState, type ReactNode } from "react";
import type { FileReply, TreeEntry, TreeReply } from "../../shared/files.js";
import { fmt, t } from "../i18n/index.js";
import { fetchFile, fetchTree, Refused } from "../state/api.js";
import { changesOf } from "../state/panels.js";
import type { State } from "../state/model.js";
import { Markdown } from "../stream/Answer.js";

interface Props {
	readonly state: State;
	readonly wkey: string | null;
	readonly onRoot: (root: string) => void;
	readonly root: string | null;
}

const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

/** The folder as a tree (one level at a time), with a preview of a file; files the latest run changed are marked. */
export function Files({ state, wkey, root, onRoot }: Props): ReactNode {
	const [path, setPath] = useState("");
	const [tree, setTree] = useState<TreeReply | null>(null);
	const [file, setFile] = useState<{ readonly path: string; readonly reply: FileReply | null; readonly why: string | null } | null>(null);
	const changed = new Set(changesOf(state, root).map((c) => c.path));
	useEffect(() => {
		let alive = true;
		void fetchTree(wkey, path).then(
			(r) => {
				if (!alive) return;
				setTree(r);
				onRoot(r.root);
			},
			() => alive && setTree({ root: root ?? "", path, entries: [], more: 0 }),
		);
		return () => {
			alive = false;
		};
	}, [wkey, path]);
	const join = (name: string): string => (path === "" ? name : `${path}/${name}`);
	const open = (e: TreeEntry): void => {
		if (e.folded === true || e.outside === true) return;
		if (e.kind === "dir") return setPath(join(e.name));
		const target = join(e.name);
		setFile({ path: target, reply: null, why: null });
		void fetchFile(wkey, target).then(
			(reply) => setFile({ path: target, reply, why: null }),
			(error) => setFile({ path: target, reply: null, why: error instanceof Refused ? error.message : "unreadable" }),
		);
	};
	if (file !== null) {
		const r = file.reply;
		return (
			<div data-panel-body="file">
				<button className="crumb" onClick={() => setFile(null)}>
					‹ {t.back} · <b>{file.path}</b>
				</button>
				{file.why !== null ? <div className="empty">{fmt(t.refused, { why: file.why })}</div> : null}
				{r?.kind === "markdown" ? (
					<div className="ans mdprev">
						<Markdown text={r.text ?? ""} />
					</div>
				) : null}
				{r?.kind === "text" ? <pre className="log txt">{r.text}</pre> : null}
				{r?.kind === "image" ? <img className="imgprev" src={r.dataUrl} alt={file.path} /> : null}
				{r?.kind === "binary" ? <div className="empty">{fmt(t.binaryFile, { size: kb(r.size) })}</div> : null}
				{r?.kind === "toolarge" ? <div className="empty">{fmt(t.tooLarge, { size: kb(r.size) })}</div> : null}
				{r?.truncated === true ? <div className="pnote">{t.cutText}</div> : null}
			</div>
		);
	}
	return (
		<div data-panel-body="files">
			<div className="crumbs">
				<button onClick={() => setPath("")}>{t.panelFiles}</button>
				{path.split("/").filter((p) => p !== "").map((p, i, all) => (
					<button key={i} onClick={() => setPath(all.slice(0, i + 1).join("/"))}>
						/ {p}
					</button>
				))}
			</div>
			<div className="tree">
				{(tree?.entries ?? []).map((e) => (
					<button key={e.name} onClick={() => open(e)} data-entry={e.name} data-folded={e.folded === true} disabled={e.outside === true}>
						<b>{e.name}{e.kind === "dir" ? "/" : ""}</b>
						<span className={changed.has(join(e.name)) ? "plus" : ""}>{e.folded === true ? t.notListed : e.outside === true ? t.outside : changed.has(join(e.name)) ? t.modified : e.kind === "file" ? kb(e.size) : ""}</span>
					</button>
				))}
				{tree !== null && tree.more > 0 ? <div className="pnote">{fmt(t.items, { n: tree.more })}</div> : null}
			</div>
		</div>
	);
}
