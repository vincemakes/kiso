import { useEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { I } from "../stream/Icons.js";
import type { State, Step } from "../state/model.js";
import { discoverUrls, previewUrl } from "../state/panels.js";

/**
 * A page on this computer, in a sandboxed frame. Not a browser: only http on
 * localhost or 127.0.0.1 (previewUrl), never this app's own host, no
 * navigation controls beyond reload. A dev server's address is found in the
 * output of the latest run's commands and the tasks' output.
 */
/** One browser tab. `focus`: the address it opens with (a link in the stream, or a tab's own); `auto`: the first tab also takes the
 *  first address a dev server printed; `onNav`: the address it now shows, for the tab's label. */
export function Preview({ state, focus = null, auto = true, onNav }: { readonly state: State; readonly focus?: string | null; readonly auto?: boolean; readonly onNav?: (url: string) => void }): ReactNode {
	const own = location.port;
	const [input, setInput] = useState("");
	const [url, setUrl] = useState<string | null>(null);
	const [bad, setBad] = useState(false);
	const frame = useRef<HTMLIFrameElement>(null);
	const lines = [
		...state.tasks.flatMap((x) => x.tail),
		...(state.turns.at(-1)?.items ?? []).filter((i): i is Step => i.kind === "step" && i.name === "shell").flatMap((s) => s.output?.head ?? []),
	];
	const found = discoverUrls(lines, own);
	useEffect(() => {
		if (auto && url === null && found[0] !== undefined) {
			setUrl(found[0]);
			setInput(found[0]);
			onNav?.(found[0]);
		}
	}, [url, found[0]]);
	useEffect(() => {
		if (focus !== null) go(focus);
	}, [focus]);
	const go = (raw: string): void => {
		const next = previewUrl(raw, own);
		setBad(next === null);
		if (next !== null) {
			setUrl(next);
			setInput(next);
			onNav?.(next);
		}
	};
	return (
		<div className="browser" data-panel-body="web">
			<div className="urlbar">
				<input
					className="u"
					value={input}
					placeholder={t.previewHint}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && go(input)}
					data-field="url"
				/>
				<button title={t.reload} aria-label={t.reload} onClick={() => frame.current !== null && url !== null && (frame.current.src = url)} data-act="reload">
					<I.refresh />
				</button>
				{url === null ? null : (
					<a href={url} target="_blank" rel="noreferrer" title={t.openInBrowser} aria-label={t.openInBrowser} data-act="open-external">
						<I.external />
					</a>
				)}
			</div>
			{bad ? <div className="pnote warn">{t.previewRefused}</div> : null}
			{found.length > 1 ? (
				<div className="chips">
					{found.map((f) => (
						<button key={f} onClick={() => go(f)}>
							{f}
						</button>
					))}
				</div>
			) : null}
			{url === null ? (
				<div className="empty pad">{t.previewNone}</div>
			) : (
				<iframe ref={frame} title="preview" src={url} sandbox="allow-scripts allow-same-origin allow-forms" referrerPolicy="no-referrer" data-frame={url} />
			)}
		</div>
	);
}
