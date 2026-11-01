import { useEffect, useState, type ReactNode } from "react";
import type { FileReply } from "../../shared/files.js";
import { fmt, t } from "../i18n/index.js";
import { fetchFile, Refused } from "../state/api.js";
import type { State } from "../state/model.js";
import { changesOf } from "../state/panels.js";
import { Markdown } from "../stream/Answer.js";
import { ChangeView } from "./Changes.js";

type Mode = "rendered" | "source" | "changes" | "image";

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const LABEL: Readonly<Record<Mode, string>> = { rendered: t.modeRendered, source: t.modeSource, changes: t.modeChanges, image: "" };

/**
 * One file of the folder, opened from a chip: markdown Rendered / Source / Changes, an image fitted to the width (a click
 * shows it at 100%), code and other text as its Changes when the run changed it, else its Source. A page is its Source
 * here. Read through the folder's file door, so what may be read is the host's call, as in Files.
 */
export function Open({ state, wkey, root, path }: { readonly state: State; readonly wkey: string | null; readonly root: string | null; readonly path: string }): ReactNode {
	const change = changesOf(state, root).find((c) => c.path === path) ?? null;
	const modes: Mode[] = IMAGE.test(path) ? ["image"] : MARKDOWN.test(path) ? ["rendered", "source"] : ["source"];
	if (change !== null && modes[0] !== "image") modes.push("changes");
	const [mode, setMode] = useState<Mode>(modes[0] === "source" && change !== null ? "changes" : modes[0]!);
	const [file, setFile] = useState<{ readonly reply: FileReply | null; readonly why: string | null }>({ reply: null, why: null });
	const [actual, setActual] = useState(false);
	useEffect(() => {
		let alive = true;
		void fetchFile(wkey, path).then(
			(reply) => alive && setFile({ reply, why: null }),
			(error) => alive && setFile({ reply: null, why: error instanceof Refused ? error.message : "unreadable" }),
		);
		return () => {
			alive = false;
		};
	}, [wkey, path]);
	const r = file.reply;
	return (
		<div data-panel-body="open" data-path={path} data-mode={mode}>
			{modes.length > 1 ? (
				<div className="modes">
					{modes.map((m) => (
						<button key={m} className={m === mode ? "on" : ""} onClick={() => setMode(m)} data-mode={m}>
							{LABEL[m]}
						</button>
					))}
				</div>
			) : null}
			{file.why !== null ? <div className="empty">{fmt(t.refused, { why: file.why })}</div> : null}
			{mode === "changes" && change !== null ? <ChangeView c={change} /> : null}
			{mode === "rendered" && r?.text !== undefined ? (
				<div className="ans mdprev">
					<Markdown text={r.text} />
				</div>
			) : null}
			{mode === "source" && r?.text !== undefined ? <pre className="log txt">{r.text}</pre> : null}
			{mode === "image" && r?.kind === "image" ? <img className={`imgprev${actual ? " actual" : ""}`} src={r.dataUrl} alt={path} onClick={() => setActual(!actual)} /> : null}
			{r?.kind === "binary" ? <div className="empty">{t.binaryFile.replace("{size}", `${r.size} B`)}</div> : null}
			{r?.kind === "toolarge" ? <div className="empty">{t.tooLarge.replace("{size}", `${r.size} B`)}</div> : null}
			{r?.truncated === true && mode !== "changes" ? <div className="pnote">{t.cutText}</div> : null}
		</div>
	);
}
