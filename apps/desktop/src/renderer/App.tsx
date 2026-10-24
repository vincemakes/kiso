import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Sidebar } from "./sidebar/Sidebar.js";
import { Sidebar as SidebarIcon } from "./stream/Icons.js";
import { WorkView } from "./stream/WorkView.js";
import { Settings } from "./settings/Settings.js";
import { launchParams, openSession, type Session } from "./state/store.js";
import { fetchHistory, newWorkId, sessionsUrl, type Target } from "./state/works.js";
import { t } from "./i18n/index.js";
import type { HistoryReply, WorkRow } from "../shared/history.js";

// read once, when the page loads: the address fragment can be read only once
const launch = launchParams();
const POLL_MS = 3_000;

/**
 * The window: the sidebar (closed at first; opening pushes the Work to the
 * right), the Work in view or Settings. A Work is opened as a session on its
 * folder's routes; opening another closes the stream of the one before.
 */
export function App(): ReactNode {
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<"work" | "settings">("work");
	const [target, setTarget] = useState<Target>(() => ({ key: null, sessionId: launch.sessionId ?? newWorkId() }));
	const [opened, setOpened] = useState<{ readonly target: Target; readonly session: Session } | null>(null);
	const session = opened !== null && opened.target === target ? opened.session : null;
	const [history, setHistory] = useState<HistoryReply | null>(null);

	useEffect(() => {
		const next = openSession({ baseUrl: sessionsUrl(location.origin, target.key), token: launch.token, sessionId: target.sessionId });
		(window as unknown as { __kiso?: Session }).__kiso = next; // read by the proof scripts through the debugging port
		setOpened({ target, session: next });
		return () => next.stop();
	}, [target]);

	const refresh = useCallback(
		(fresh?: string) => {
			void fetchHistory(launch.token, fresh).then(setHistory, () => undefined);
		},
		[],
	);
	// the history is read while the sidebar is open, and while some folder is still being read
	useEffect(() => {
		if (!open && history !== null && !history.scanning) return;
		const timer = setInterval(() => refresh(), POLL_MS);
		if (history === null || open) refresh();
		return () => clearInterval(timer);
	}, [open, history === null || history.scanning, refresh]);
	// a Work that is not in the history yet (its first request just went out) is read fresh once it has an answer
	const version = session?.version() ?? 0;
	const shown = history?.works.some((w) => w.id === target.sessionId) ?? false;
	const started = (session?.state.turns.length ?? 0) > 0;
	useEffect(() => {
		if (started && !shown && history !== null) refresh(target.key ?? history.current.key);
	}, [started, shown, version, target, history === null, refresh]);

	const activeKey = target.key ?? history?.current.key ?? "";
	const rows: readonly WorkRow[] = history?.works ?? [];
	const openWork = (row: WorkRow): void => {
		setView("work");
		setTarget({ key: row.key === history?.current.key ? null : row.key, sessionId: row.id });
	};
	return (
		<div className="win" data-side={open ? "1" : "0"}>
			<div className="drag" />
			<button className="sidetoggle" onClick={() => setOpen(!open)} aria-label={open ? t.closeSidebar : t.openSidebar} data-act="sidebar">
				<SidebarIcon />
			</button>
			<Sidebar
				works={rows}
				active={{ key: activeKey, id: target.sessionId }}
				settingsOn={view === "settings"}
				onOpen={openWork}
				onNew={() => {
					setView("work");
					setTarget({ key: null, sessionId: newWorkId() });
				}}
				onSettings={() => setView("settings")}
			/>
			<main className="main">{view === "settings" ? <Settings token={launch.token} /> : session === null ? null : <WorkView key={`${target.key ?? ""}/${target.sessionId}`} session={session} auto={launch.auto} />}</main>
		</div>
	);
}
