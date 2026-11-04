import type { ReactNode } from "react";

const svg = (children: ReactNode, size = 15): ReactNode => (
	<svg className="ico" viewBox="0 0 24 24" style={{ width: size, height: size }}>
		{children}
	</svg>
);

export const Chevron = (): ReactNode => (
	<svg className="ico chev" viewBox="0 0 24 24" style={{ width: 13, height: 13 }} aria-hidden="true">
		<path d="m9 6 6 6-6 6" />
	</svg>
);
/** The kiso mark (the quatrefoil of assets/logo.svg), in the text colour. */
export const Mark = ({ size = 19 }: { readonly size?: number }): ReactNode => (
	<svg className="mark" viewBox="0 0 100 100" style={{ width: size, height: size }} aria-hidden="true">
		<path fill="currentColor" d="m89 54c-0.5-1.3-0.8-2.7-0.8-3.9 0.2-5.5 7-11.1 9.5-19.4 2.2-7.3 2.2-17.3-5.2-23.8-2.7-2.4-7-4.7-12.7-4.7-2.6 0-5.3 0.4-7.8 1.2-4.7 1.5-7.8 3.5-14.5 7.8-2.6 1.5-4.6 2.6-7.5 2.6s-5-1.1-7.5-2.6c-6.7-4.3-11.1-7.2-15.8-8.3-1.6-0.4-3.5-0.7-6.1-0.7-5.7 0-10 2-12.9 4.7-7.3 6.7-7.4 16-5.2 22.9 2.6 7.9 8.4 13.1 8.9 18.8 0.2 1.6 0 3.5-0.9 5.4-2.8 5.7-8.4 10.9-8.9 21.5-0.2 4.2 0.3 8.9 2.8 13.1 2.1 3.3 6.5 8.3 16 8.5 12.5 0.2 18.8-6.9 25.8-9.6 1.3-0.5 2.5-0.7 3.8-0.7 6.7 0 11.4 6.9 21.9 9.8 2.2 0.7 4.7 1.1 7.5 1.2 4.2 0 7.5-0.8 10.2-2.3 4-2.1 6.5-5.8 7.7-8.8 1.1-2.9 1.6-5.9 1.6-8.8-0.2-10.6-7.3-17.4-9.9-23.9zm-71.2-3.6c6.4-0.4 11.6-1 17.4-4.2 3.3-1.8 6.4-4.5 8.6-7.3 3.1-4.2 5.6-9.5 6.1-17.1l0.1-2.2 0.2 2.2c1.2 13.1 9.3 20.8 16.2 24.3 4.5 2.4 8.7 3.6 15.8 4.1v0.2c-5.3 0.2-9.3 1-13.2 2.6-4.8 1.9-9.4 5.1-12.6 9.2-3.5 4.7-5.8 10-6.3 17.5l-0.1 1.4-0.2-2c-0.4-5.7-2.3-11-5.4-15.3-2.3-3.3-5.3-6.1-8.9-8.2-3.4-2.1-8-4.2-15.9-5.1l-1.8-0.1z" />
	</svg>
);
export const Warn = (): ReactNode => svg(<path d="M12 4 2.5 20h19L12 4ZM12 10v4M12 17.5v.01" />, 16);
export const Plus = (): ReactNode => svg(<path d="M12 5v14M5 12h14" />, 16);
export const Sliders = (): ReactNode => svg(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>, 16);
export const Overview = (): ReactNode => svg(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M8 9h8M8 12.5h8M8 16h5" /></>, 17);
export const Sidebar = (): ReactNode => svg(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15" /></>, 17);
export const Copy = (): ReactNode => svg(<><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>, 14);
export const Check = (): ReactNode => svg(<path d="m5 12.5 4.5 4.5L19 7.5" />, 14);
/** Fork: Lucide's `split` (ISC), turned a quarter clockwise so the stem comes in from the left and the branches part to the right (owner 2026-11-03). */
export const Fork = (): ReactNode => svg(<g transform="rotate(90 12 12)"><path d="M16 3h5v5" /><path d="M8 3H3v5" /><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3" /><path d="m15 9 6-6" /></g>, 14);
export const PullRequest = (): ReactNode => svg(<><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M6 8.2v7.6M18 15.8V10a3 3 0 0 0-3-3h-4.5M12.5 4.5 10 7l2.5 2.5" /></>, 14);
export const ArrowUp = (): ReactNode => svg(<path d="M12 19V5M6 11l6-6 6 6" />, 16);

/** The rail's and the viewer's set: one 16 px box, one 1.75 stroke (`.i16`), so a branch, a folder and a file read the same size. */
const i16 = (children: ReactNode): (() => ReactNode) => () => (
	<svg className="i16" viewBox="0 0 24 24" aria-hidden="true">
		{children}
	</svg>
);
export const I = {
	term: i16(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></>),
	branch: i16(<><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="7" r="2" /><path d="M6 7v10M18 9c0 5-6 4-11 8" /></>),
	folder: i16(<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
	file: i16(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>),
	code: i16(<path d="m9 8-4 4 4 4M15 8l4 4-4 4" />),
	globe: i16(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3" /></>),
	image: i16(<><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m21 16-5-5-9 9" /></>),
	md: i16(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 15V9l2.5 3L12 9v6M16 9v6M14 13l2 2 2-2" /></>),
	check: i16(<path d="M5 12.5 10 17l9-10" />),
	computer: i16(<><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>),
	external: i16(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />),
	close: i16(<path d="M6 6l12 12M18 6 6 18" />),
	download: i16(<path d="M12 4v12M7 11l5 5 5-5M5 20h14" />),
	chevron: i16(<path d="m6 9 6 6 6-6" />),
	refresh: i16(<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />),
	plus: i16(<path d="M12 5v14M5 12h14" />),
	pr: i16(<><circle cx="6" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2" /></>),
};
/** An artifact's icon by its kind and name: an image, a page, markdown, code or any other file. */
export const artifactIcon = (kind: string, path: string): ReactNode =>
	kind === "image" ? <I.image /> : kind === "page" || /^https?:/.test(path) ? <I.globe /> : /\.(md|markdown)$/i.test(path) ? <I.md /> : /\.(tsx?|jsx?|mjs|css|py|go|rs|json)$/i.test(path) ? <I.code /> : <I.file />;

const ICONS: Readonly<Record<string, ReactNode>> = {
	read_file: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></>),
	edit_file: svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />),
	shell: svg(<path d="m5 8 5 4-5 4M12 17h7" />),
	search_text: svg(<><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>),
	list_dir: svg(<path d="M4 6h16M4 12h16M4 18h10" />),
};
export const toolIcon = (name: string): ReactNode => ICONS[name] ?? ICONS["shell"];
