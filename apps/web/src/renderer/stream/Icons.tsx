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
