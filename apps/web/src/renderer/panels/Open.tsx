import { useEffect, useState, type ReactNode } from "react";
import type { FileReply } from "../../shared/files.js";
import { fmt, t } from "../i18n/index.js";
import { fetchFile, Refused } from "../state/api.js";
import type { State } from "../state/model.js";
import { changesOf } from "../state/panels.js";
import { Markdown } from "../stream/Answer.js";
import { useImageSrc } from "../stream/Artifacts.js";
import { ChangeView } from "./Changes.js";

type Mode = "rendered" | "source" | "changes" | "image" | "page" | "pdf" | "video" | "audio";

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
const MARKDOWN = /\.(md|markdown)$/i;
const SERVED: readonly [RegExp, Mode][] = [[/\.html?$/i, "page"], [/\.pdf$/i, "pdf"], [/\.(mp4|webm|mov)$/i, "video"], [/\.(mp3|wav)$/i, "audio"]];
const LABEL: Readonly<Record<Mode, string>> = { rendered: t.modeRendered, source: t.modeSource, changes: t.modeChanges, page: t.modePage, image: "", pdf: "", video: "", audio: "" };

/** The address of `path` on its own preview server (main/preview.ts), closed again with the view. */
function usePreview(wkey: string | null, path: string, on: boolean): { readonly url: string | null; readonly why: string | null } {
	const [got, setGot] = useState<{ readonly url: string | null; readonly why: string | null }>({ url: null, why: null });
	useEffect(() => {
		if (!on) return;
		let url: string | null = null;
		const post = (door: string, body: unknown): Promise<Response> => fetch(`${door}${wkey === null ? "" : `?key=${encodeURIComponent(wkey)}`}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		void post("/desk/preview", { path })
			.then(async (r) => ((await r.json()) as { url?: string; message?: string }))
			.then((r) => (r.url === undefined ? setGot({ url: null, why: r.message ?? "refused" }) : setGot({ url: (url = r.url), why: null })), () => setGot({ url: null, why: "unreachable" }));
		return () => {
			if (url !== null) void post("/desk/preview-close", { url });
		};
	}, [wkey, path, on]);
	return got;
}

/**
 * One item, opened from a chip or a thumbnail: markdown Rendered / Source / Changes; a page as the Page (on its own preview
 * server, in a frame that may run scripts and nothing else) / Source / Changes; a pdf in the browser's viewer and video or audio,
 * from the same kind of server; an image fitted to the width (a click shows it at 100%), an image a tool returned included
 * (`log:<work>/<seq>/<n>`); code and other text as its Changes when the run changed it, else its Source.
 */
export function Open({ state, wkey, root, path }: { readonly state: State; readonly wkey: string | null; readonly root: string | null; readonly path: string }): ReactNode {
	const change = changesOf(state, root).find((c) => c.path === path) ?? null;
	const served = SERVED.find(([re]) => re.test(path))?.[1];
	const modes: Mode[] = path.startsWith("log:") || IMAGE.test(path) ? ["image"] : MARKDOWN.test(path) ? ["rendered", "source"] : served === "page" ? ["page", "source"] : served !== undefined ? [served] : ["source"];
	if (change !== null && ["rendered", "source", "page"].includes(modes[0]!)) modes.push("changes");
	const [mode, setMode] = useState<Mode>(modes[0] === "source" && change !== null ? "changes" : modes[0]!);
	const [file, setFile] = useState<{ readonly reply: FileReply | null; readonly why: string | null }>({ reply: null, why: null });
	const [actual, setActual] = useState(false);
	const reads = modes.includes("source");
	const preview = usePreview(wkey, path, served !== undefined && mode !== "source" && mode !== "changes");
	const src = useImageSrc(mode === "image" ? path : "");
	useEffect(() => {
		if (!reads) return;
		let alive = true;
		void fetchFile(wkey, path).then(
			(reply) => alive && setFile({ reply, why: null }),
			(error) => alive && setFile({ reply: null, why: error instanceof Refused ? error.message : "unreadable" }),
		);
		return () => {
			alive = false;
		};
	}, [wkey, path, reads]);
	const r = file.reply;
	return (
		<div data-panel-body="open" data-path={path} data-mode={mode} className={served !== undefined && mode !== "source" && mode !== "changes" ? "served" : ""}>
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
			{preview.why !== null ? <div className="empty">{fmt(t.previewFailed, { why: preview.why })}</div> : null}
			{mode === "changes" && change !== null ? <ChangeView c={change} /> : null}
			{mode === "rendered" && r?.text !== undefined ? (
				<div className="ans mdprev">
					<Markdown text={r.text} />
				</div>
			) : null}
			{mode === "source" && r?.text !== undefined ? <pre className="log txt">{r.text}</pre> : null}
			{mode === "image" && src !== null ? <img className={`imgprev${actual ? " actual" : ""}`} src={src} alt={path} onClick={() => setActual(!actual)} /> : null}
			{/* scripts may run, in an opaque origin: no same-origin, forms, popups or top navigation */}
			{(mode === "page" || mode === "pdf") && preview.url !== null ? <iframe className="pageview" title={path} src={preview.url} sandbox="allow-scripts" referrerPolicy="no-referrer" data-frame={preview.url} /> : null}
			{mode === "video" && preview.url !== null ? <video className="mediaview" src={preview.url} controls /> : null}
			{mode === "audio" && preview.url !== null ? <audio className="mediaview" src={preview.url} controls /> : null}
			{r?.kind === "binary" && reads ? <div className="empty">{t.binaryFile.replace("{size}", `${r.size} B`)}</div> : null}
			{r?.kind === "toolarge" && reads ? <div className="empty">{t.tooLarge.replace("{size}", `${r.size} B`)}</div> : null}
			{r?.truncated === true && mode === "source" ? <div className="pnote">{t.cutText}</div> : null}
		</div>
	);
}
