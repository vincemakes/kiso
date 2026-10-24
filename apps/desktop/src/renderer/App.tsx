import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Sidebar } from "./sidebar/Sidebar.js";
import { Overview, Sidebar as SidebarIcon } from "./stream/Icons.js";
import { Rail } from "./rail/Rail.js";
import { railOf } from "./rail/derive.js";
import { WorkView } from "./stream/WorkView.js";
import { Settings } from "./settings/Settings.js";
import { launchParams, openSession, type Session } from "./state/store.js";
import { fetchEnv, fetchHistory, newWorkId, sessionsUrl, type Target } from "./state/works.js";
import { t } from "./i18n/index.js";
import type { HistoryReply, WorkRow } from "../shared/history.js";
import type { EnvReply } from "../shared/settings.js";

// read once, when the page loads: the address fragment can be read only once
const launch = launchParams();
const POLL_MS = 3_000;
const NARROW = "(max-width: 900px)";
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const NO_VERSION = (): number => 0;

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
	const [env, setEnv] = useState<EnvReply | null>(null);
	// the person's choice for the rail; unchosen, it is open in a wide window and closed in a narrow one (where it overlays the Work)
	const [railChoice, setRailChoice] = useState<boolean | null>(null);
	const [narrow, setNarrow] = useState(() => matchMedia(NARROW).matches);
	useEffect(() => {
		const query = matchMedia(NARROW);
		const on = (): void => setNarrow(query.matches);
		query.addEventListener("change", on);
		return () => query.removeEventListener("change", on);
	}, []);

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
	const version = useSyncExternalStore(session?.subscribe ?? NO_SUBSCRIPTION, session?.version ?? NO_VERSION);
	const shown = history?.works.some((w) => w.id === target.sessionId) ?? false;
	const started = (session?.state.turns.length ?? 0) > 0;
	useEffect(() => {
		if (started && !shown && history !== null) refresh(target.key ?? history.current.key);
	}, [started, shown, version, target, history === null, refresh]);

	useEffect(() => {
		if (view === "work") void fetchEnv(launch.token, target.key).then(setEnv, () => undefined);
	}, [target, view]);
	const railOn = started && view === "work";
	const railOpen = railOn && (railChoice ?? !narrow);
	const attention = session === null ? 0 : railOf(session.state).attention;
	const activeKey = target.key ?? history?.current.key ?? "";
	const rows: readonly WorkRow[] = history?.works ?? [];
	const openWork = (row: WorkRow): void => {
		setView("work");
		setTarget({ key: row.key === history?.current.key ? null : row.key, sessionId: row.id });
	};
	return (
		<div className="win" data-side={open ? "1" : "0"} data-rail={railOpen ? "1" : "0"}>
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
			{railOn ? (
				<button className={`railtoggle${railOpen ? " on" : ""}`} onClick={() => setRailChoice(!railOpen)} aria-label={t.overview} aria-pressed={railOpen} data-act="rail">
					<Overview />
					{attention > 0 ? (
						<span className="tbadge" data-field="badge">
							{attention}
						</span>
					) : null}
				</button>
			) : null}
			{railOn && session !== null ? <Rail state={session.state} env={env} /> : null}
			<main className="main">{view === "settings" ? <Settings token={launch.token} /> : session === null ? null : <WorkView key={`${target.key ?? ""}/${target.sessionId}`} session={session} auto={launch.auto} />}</main>
		</div>
	);
}
