import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ArtifactRef } from "../../shared/frames.js";
import { t } from "../i18n/index.js";
import { useOpenPanel } from "../panels/context.js";
import { fetchFile } from "../state/api.js";
import type { Step } from "../state/model.js";
import { FileIcon, KeyContext } from "./links.js";

/**
 * What a step made, drawn: a small thumbnail at the right of its row (an image scaled; a page as a static placeholder, its icon and
 * <title>, never a live frame, so no script of it runs; anything else its type's tile), the first three of a group on its line,
 * and an image opened in place at column width. A click on a thumbnail opens the item in the Open panel.
 */

/** Whether the stream is pinned to the bottom (the person follows the newest): an image opens by itself only then. */
export const PinnedContext = createContext<() => boolean>(() => true);

export const artifactsOf = (step: Step): readonly ArtifactRef[] => step.output?.artifacts ?? [];

/** The Open panel's name for an artifact: a file's path, or `log:<work>/<seq>/<n>` for an image block of a result. */
export const focusOf = (a: ArtifactRef): string => (a.uri.startsWith("file:") ? a.uri.slice(5) : `log:${a.workId}/${a.uri.slice(4)}`);

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
	const open = useOpenPanel();
	const focus = focusOf(a);
	return (
		<span
			role="button"
			tabIndex={0}
			className="tn"
			data-thumb={a.kind}
			data-artifact={focus}
			title={focus.startsWith("log:") ? t.imageResult : focus}
			onClick={(e) => {
				e.stopPropagation();
				open("open", focus);
			}}
		>
			{a.kind === "image" ? <Picture focus={focus} className="tn-img" /> : a.kind === "page" ? <PagePlaceholder path={focus} /> : <FileIcon path={focus} />}
		</span>
	);
}

/** The first `max` thumbnails, then +N. */
export function Thumbs({ items, max = 3 }: { readonly items: readonly ArtifactRef[]; readonly max?: number }): ReactNode {
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

/** A step's images, opened in place at column width; a click opens one in the Open panel. */
export function InPlace({ step }: { readonly step: Step }): ReactNode {
	const open = useOpenPanel();
	return (
		<div className="inplace" data-kind="inplace">
			{artifactsOf(step)
				.filter((a) => a.kind === "image")
				.map((a) => (
					<span key={a.id} role="button" tabIndex={0} onClick={() => open("open", focusOf(a))}>
						<Picture focus={focusOf(a)} className="ip-img" />
					</span>
				))}
		</div>
	);
}
