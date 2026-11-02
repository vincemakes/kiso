import { createContext, useContext, useEffect, type ReactNode } from "react";
import type { ArtifactRef } from "../../shared/frames.js";
import { t } from "../i18n/index.js";
import { useOpenPanel } from "../panels/context.js";
import { focusOf, Picture, useImageSrc } from "./Artifacts.js";
import { I } from "./Icons.js";

/** Opens an image over the whole window; provided by the App, which draws the one lightbox. */
export const LightboxContext = createContext<(focus: string) => void>(() => undefined);

/**
 * The one way an artifact opens, wherever it is clicked (a step's thumbnail, the run's strip, the rail's Outputs): an image in the
 * lightbox, anything else (a page, markdown, html, a file) in the Open panel, the same as the stream has always opened it.
 */
export function useOpenArtifact(): (a: ArtifactRef) => void {
	const open = useOpenPanel();
	const lightbox = useContext(LightboxContext);
	return (a) => (a.kind === "image" ? lightbox(focusOf(a)) : open("open", focusOf(a)));
}

/** The image, the window's width at most; download, open in a tab (an image of the log, which has an address; a file's bytes come as a data URL a tab may not open), close (Esc, the button, or a click beside the image). */
export function Lightbox({ focus, onClose }: { readonly focus: string; readonly onClose: () => void }): ReactNode {
	const src = useImageSrc(focus);
	useEffect(() => {
		const key = (e: KeyboardEvent): void => void (e.key === "Escape" && onClose());
		addEventListener("keydown", key);
		return () => removeEventListener("keydown", key);
	}, [onClose]);
	const name = focus.startsWith("log:") ? t.imageResult : (focus.split("/").pop() ?? focus);
	return (
		<div className="lightbox" data-kind="lightbox" role="dialog" aria-label={name} onClick={(e) => e.target === e.currentTarget && onClose()}>
			<div className="lb-acts">
				{src !== null ? (
					<a className="lb-b" href={src} download={name} aria-label={t.download} data-act="lb-download">
						<I.download />
					</a>
				) : null}
				{src?.startsWith("/") === true ? (
					<a className="lb-b" href={src} target="_blank" rel="noreferrer" aria-label={t.openInTab} data-act="lb-tab">
						<I.external />
					</a>
				) : null}
				<button className="lb-b" onClick={onClose} aria-label={t.panelClose} data-act="lb-close">
					<I.close />
				</button>
			</div>
			<Picture focus={focus} className="lb-img" />
			<div className="lb-cap">{name}</div>
		</div>
	);
}
