import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ArtifactRef } from "../../shared/frames.js";
import { t } from "../i18n/index.js";
import { useOpenArtifact } from "./Lightbox.js";
import { fetchFile } from "../state/api.js";
import type { Step } from "../state/model.js";
import { FileIcon, KeyContext } from "./links.js";

/**
 * What a step made, drawn: a small thumbnail at the right of its row (an image scaled; a page as a static placeholder, its icon and
 * <title>, never a live frame, so no script of it runs; anything else its type's tile), the first three of a group on its line,
 * and an image opened in place at column width. A click opens the item the one way (`useOpenArtifact`): an image in the lightbox, the rest in the Open panel.
 */

/** Whether the stream is pinned to the bottom (the person follows the newest): an image opens by itself only then. */
export const PinnedContext = createContext<() => boolean>(() => true);

export const artifactsOf = (step: Step): readonly ArtifactRef[] => {
	const all = step.output?.artifacts ?? [];
	for (const a of all) if (a.name !== undefined) NAMES.set(focusOf(a), a.name);
	return all;
};

/** The Open panel's name for an artifact: a file's path, or `log:<work>/<seq>/<n>` for an image block of a result. */
export const focusOf = (a: ArtifactRef): string => (a.uri.startsWith("file:") ? a.uri.slice(5) : `log:${a.workId}/${a.uri.slice(4)}`);

/** What a focus is called where it is listed: a file's name; a picture of the log by the name the host gave it (the kept file's
 *  name, or the tool and the result), read as its step is drawn; the generic words only for a log older than names. */
const NAMES = new Map<string, string>();
export const nameOf = (focus: string): string => (focus.startsWith("log:") ? (NAMES.get(focus) ?? t.imageResult) : (focus.split("/").pop() ?? focus));

/** Where an image's bytes are: the log route for a block, the file door (a data URL) for a file. */
export function useImageSrc(focus: string): string | null {
	const key = useContext(KeyContext);
	const [src, setSrc] = useState<string | null>(null);
	useEffect(() => {
		if (focus === "") return setSrc(null);
		if (focus.startsWith("log:")) return setSrc(`/desk/image/${focus.slice(4)}${key === null ? "" : `?key=${encodeURIComponent(key)}`}`);
		let alive = true;
		void fetchFile(key, focus).then((r) => alive && r.kind === "image" && setSrc(r.dataUrl ?? null), () => undefined);
		return () => {
			alive = false;
		};
	}, [focus, key]);
	return src;
}

/** An image, or "no longer available" where it fails (a file since deleted, an address that is gone). */
export function Picture({ focus, className }: { readonly focus: string; readonly className: string }): ReactNode {
	const src = useImageSrc(focus);
	const [gone, setGone] = useState(false);
	if (gone) return <span className={`${className} gone`}>{t.imageGone}</span>;
	return src === null ? <span className={className} /> : <img className={className} src={src} alt="" onError={() => setGone(true)} />;
}

/** A page's placeholder: its icon and its <title> (read as text, never run). */
function PagePlaceholder({ path }: { readonly path: string }): ReactNode {
	const key = useContext(KeyContext);
	const [title, setTitle] = useState("");
	useEffect(() => {
		void fetchFile(key, path).then((r) => setTitle(/<title[^>]*>([^<]*)<\/title>/i.exec(r.text ?? "")?.[1]?.trim() ?? ""), () => undefined);
	}, [path, key]);
	return (
		<span className="tpage">
			<FileIcon path={path} />
			<span>{title || path.split("/").pop()}</span>
		</span>
	);
}

export function Thumb({ a }: { readonly a: ArtifactRef }): ReactNode {
	const open = useOpenArtifact();
	const focus = focusOf(a);
	return (
		<span
			role="button"
			tabIndex={0}
			className="tn"
			data-thumb={a.kind}
			data-artifact={focus}
			title={focus.startsWith("log:") ? nameOf(focus) : focus}
			onClick={(e) => {
				e.stopPropagation();
				open(a);
			}}
		>
			{a.kind === "image" ? <Picture focus={focus} className="tn-img" /> : a.kind === "page" ? <PagePlaceholder path={focus} /> : <FileIcon path={focus} />}
		</span>
	);
}

/** The first `max` pictures a step or a group made, then +N. Only pictures get a thumbnail: a file's tile showed its type's icon and
 *  nothing of the file (owner, 2026-11-02; W1c drew a tile for every artifact). Files are in the run's strip and the rail's Outputs. */
export function Thumbs({ items: all, max = 3 }: { readonly items: readonly ArtifactRef[]; readonly max?: number }): ReactNode {
	const items = all.filter((a) => a.kind === "image");
	if (items.length === 0) return null;
	return (
		<span className="tns">
			{items.slice(0, max).map((a) => (
				<Thumb key={a.id} a={a} />
			))}
			{items.length > max ? <span className="tn-more">+{items.length - max}</span> : null}
		</span>
	);
}

/** A step's images, opened in place at column width; a click opens one in the lightbox. */
export function InPlace({ step }: { readonly step: Step }): ReactNode {
	const open = useOpenArtifact();
	return (
		<div className="inplace" data-kind="inplace">
			{artifactsOf(step)
				.filter((a) => a.kind === "image")
				.map((a) => (
					<span key={a.id} role="button" tabIndex={0} onClick={() => open(a)}>
						<Picture focus={focusOf(a)} className="ip-img" />
					</span>
				))}
		</div>
	);
}
