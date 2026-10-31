import type { ReactNode } from "react";

const svg = (children: ReactNode, size = 15): ReactNode => (
	<svg className="ico" viewBox="0 0 24 24" style={{ width: size, height: size }}>
		{children}
	</svg>
);

export const Chevron = (): ReactNode => svg(<path d="m9 6 6 6-6 6" />, 13);
export const Spark = (): ReactNode => (
	<svg className="spark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
		<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
	</svg>
);
export const Warn = (): ReactNode => svg(<path d="M12 4 2.5 20h19L12 4ZM12 10v4M12 17.5v.01" />, 16);
export const Plus = (): ReactNode => svg(<path d="M12 5v14M5 12h14" />, 16);
export const Sliders = (): ReactNode => svg(<><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></>, 16);
export const Overview = (): ReactNode => svg(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M8 9h8M8 12.5h8M8 16h5" /></>, 17);
export const Sidebar = (): ReactNode => svg(<><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M9.5 4.5v15" /></>, 17);
export const ArrowUp = (): ReactNode => svg(<path d="M12 19V5M6 11l6-6 6 6" />, 16);

const ICONS: Readonly<Record<string, ReactNode>> = {
	read_file: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" /><path d="M14 3v5h5" /></>),
	edit_file: svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />),
	shell: svg(<path d="m5 8 5 4-5 4M12 17h7" />),
	search_text: svg(<><circle cx="11" cy="11" r="6" /><path d="m20 20-4.5-4.5" /></>),
	list_dir: svg(<path d="M4 6h16M4 12h16M4 18h10" />),
};
export const toolIcon = (name: string): ReactNode => ICONS[name] ?? ICONS["shell"];
