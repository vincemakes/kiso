import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Sidebar } from "./sidebar/Sidebar.js";
import { Mark, Overview, Sidebar as SidebarIcon } from "./stream/Icons.js";
import { Rail } from "./rail/Rail.js";
import { PanelContext } from "./panels/context.js";
import { Panels } from "./panels/Panels.js";
import { PanelMenu } from "./panels/Menu.js";
import type { PanelKind, PanelMode } from "./state/panels.js";
import { railOf } from "./rail/derive.js";
import { isLive } from "./state/model.js";
import { RootContext } from "./stream/root.js";
import { KeyContext, WorkContext } from "./stream/links.js";
import { Loading, WorkView } from "./stream/WorkView.js";
import { Settings } from "./settings/Settings.js";
import { Guide } from "./home/Guide.js";
import { Tray } from "./home/Tray.js";
import { Folders } from "./home/Folders.js";
import { chooseFolder, fetchSettings, saveSettings, sendPresence, type OpenWork } from "./state/desk.js";
import { signIn } from "./state/auth.js";
import { watchNotices } from "./state/notify.js";
import { launchParams, openSession, type Session } from "./state/store.js";
import { fetchEnv, fetchHistory, newWorkId, sessionsUrl, type Target } from "./state/works.js";
import { t } from "./i18n/index.js";
import type { HistoryReply, WorkRow } from "../shared/history.js";
import type { EnvReply, SettingsReply } from "../shared/settings.js";

// read once, when the page loads: the address fragment can be read only once
const launch = launchParams();
const POLL_MS = 3_000;
const NO_SUBSCRIPTION = (): (() => void) => () => undefined;
const NO_VERSION = (): number => 0;

/**
 * The window: the sidebar (closed at first; opening pushes the Work to the
 * right), the Work in view or Settings. A Work is opened as a session on its
 * folder's routes; opening another closes the stream of the one before.
 */
export function App(): ReactNode {
	// null while the page trades its connect code; false: no session (the page shows one line, "run kiso web")
	const [signedIn, setSignedIn] = useState<boolean | null>(null);
	useEffect(() => void signIn(launch.code).then(setSignedIn), []);
	const [open, setOpen] = useState(false);
	const [browsing, setBrowsing] = useState(false);
	const [view, setView] = useState<"work" | "settings">("work");
	const [target, setTarget] = useState<Target>(() => ({ key: null, sessionId: launch.sessionId ?? newWorkId() }));
	const [opened, setOpened] = useState<{ readonly target: Target; readonly session: Session } | null>(null);
	const session = opened !== null && opened.target === target ? opened.session : null;
	const [history, setHistory] = useState<HistoryReply | null>(null);
	const [env, setEnv] = useState<EnvReply | null>(null);
	// the big panel: which, how wide, and the task a click in the rail asked for
	const [panel, setPanel] = useState<{ readonly kind: PanelKind; readonly mode: PanelMode; readonly focus: string | null } | null>(null);
	const [settings, setSettings] = useState<SettingsReply | null>(null);
	const [settingsBump, setSettingsBump] = useState(0);
	// an approval a system notification pointed at: its card is scrolled to and focused once the Work shows it
	const [focusDecision, setFocusDecision] = useState<string | null>(null);
	// the rail is open unless the person closes it with the overview key; no window width closes it
	const [railChoice, setRailChoice] = useState(true);

	useEffect(() => {
		if (signedIn !== true) return;
		const next = openSession({ baseUrl: sessionsUrl(location.origin, target.key), sessionId: target.sessionId });
		(window as unknown as { __kiso?: Session }).__kiso = next; // read by the proof scripts through the debugging port
		setOpened({ target, session: next });
		return () => next.stop();
	}, [target, signedIn]);

	const refresh = useCallback(
		(fresh?: string) => {
			void fetchHistory(fresh).then(setHistory, () => undefined);
		},
		[],
	);
	// the history is read while the sidebar is open, and while some folder is still being read
	useEffect(() => {
		if (signedIn !== true || (!open && history !== null && !history.scanning)) return;
		const timer = setInterval(() => refresh(), POLL_MS);
		if (history === null || open) refresh();
		return () => clearInterval(timer);
	}, [open, history === null || history.scanning, refresh, signedIn]);
	// a Work that is not in the history yet (its first request just went out) is read fresh once it has an answer
	const version = useSyncExternalStore(session?.subscribe ?? NO_SUBSCRIPTION, session?.version ?? NO_VERSION);
	const shown = history?.works.some((w) => w.id === target.sessionId) ?? false;
	const started = (session?.state.turns.length ?? 0) > 0;
	useEffect(() => {
		if (started && !shown && history !== null) refresh(target.key ?? history.current.key);
	}, [started, shown, version, target, history === null, refresh]);

	useEffect(() => {
		if (view === "work" && signedIn === true) void fetchEnv(target.key).then(setEnv, () => undefined);
	}, [target, view, signedIn]);
	const railOn = started && view === "work";
	const railOpen = railOn && railChoice;
	const attention = session === null ? 0 : railOf(session.state).attention;
	const openPanel = useCallback((kind: PanelKind, focus?: string): void => setPanel((p) => ({ kind, mode: p?.mode ?? "half", focus: focus ?? null })), []);
	useEffect(() => {
		if (view === "work" && signedIn === true) void fetchSettings(target.sessionId).then(setSettings, () => undefined);
	}, [target, view, settingsBump, signedIn]);
	const currentKey = history?.current.key ?? null;
	/** Open a Work (a fresh one, or an existing one) in whichever folder it belongs to. */
	const goTo = useCallback(
		(key: string, sessionId: string): void => {
			setView("work");
			setTarget({ key: key === currentKey ? null : key, sessionId });
		},
		[currentKey],
	);
	const openFolder = useCallback(
		(path: string): void => {
			void chooseFolder(path).then((r) => goTo(r.key, newWorkId()), () => undefined);
		},
		[goTo],
	);
	const pick = useCallback((): void => setBrowsing(true), []);
	// ⌘K: another folder
	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				pick();
			}
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [pick]);
	// a click on a browser notification: that Work, at that approval
	useEffect(() => {
		if (signedIn !== true) return;
		const open = (w: OpenWork): void => {
			goTo(w.key, w.sessionId);
			setFocusDecision(w.decisionId ?? null);
		};
		(window as unknown as { __kisoOpenWork?: (w: OpenWork) => void }).__kisoOpenWork = open; // the same entry, for the proof scripts
		return watchNotices(open, () => setSignedIn(false));
	}, [goTo, signedIn]);
	// where the person is, so the host can tell an approval that waits in front of them from one that waits out of sight
	useEffect(() => {
		if (signedIn !== true) return;
		const report = (): void => void sendPresence(target.key, target.sessionId, document.hasFocus() && document.visibilityState === "visible").catch(() => undefined);
		report();
		const timer = setInterval(report, 5_000);
		for (const type of ["focus", "blur", "visibilitychange"]) addEventListener(type, report);
		return () => {
			clearInterval(timer);
			for (const type of ["focus", "blur", "visibilitychange"]) removeEventListener(type, report);
		};
	}, [target, signedIn]);
	const activeKey = target.key ?? history?.current.key ?? "";
	// the Work on the page knows its own state first: its row follows the run's end at once, the host's list catches up on the next read
	const liveNow = session !== null && isLive(session.state);
	const ownState = !liveNow ? "idle" : (session.state.snapshot?.pendingApprovals.length ?? 0) > 0 ? "waiting" : "running";
	useEffect(() => {
		if (!liveNow && signedIn === true) refresh();
	}, [liveNow, signedIn, refresh]);
	const rows: readonly WorkRow[] = (history?.works ?? []).map((w) => (w.id === target.sessionId && w.key === activeKey ? { ...w, state: ownState } : w));
	const openWork = (row: WorkRow): void => {
		setView("work");
		setTarget({ key: row.key === history?.current.key ? null : row.key, sessionId: row.id });
	};
	if (signedIn === false) return <div className="signedout" data-kind="signedout">{t.signedOut}</div>;
	return (
		<PanelContext.Provider value={openPanel}>
		<div className="win" data-side={open ? "1" : "0"} data-rail={railOpen ? "1" : "0"} data-panel={railOn && panel !== null ? panel.mode : "closed"}>
			{browsing ? <Folders onChoose={openFolder} onClose={() => setBrowsing(false)} /> : null}
			{/* the brand: the mark and the word at the top of the open sidebar, nothing beside the toggle with it closed; a click does nothing (New task is the button below it) */}
			{open ? (
				<div className="brand" data-kind="brand">
					<Mark />
					<span className="word">kiso</span>
				</div>
			) : null}
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
			{railOn ? <PanelMenu onPick={openPanel} /> : null}
			{railOn ? (
				<button className={`railtoggle${railOpen ? " on" : ""}`} onClick={() => setRailChoice(!railChoice)} aria-label={t.overview} aria-pressed={railOpen} data-act="rail">
					<Overview />
					{attention > 0 ? (
						<span className="tbadge" data-field="badge">
							{attention}
						</span>
					) : null}
				</button>
			) : null}
			<main className="main">
				{view === "settings" ? (
					<Settings />
				) : (
					<div className={`work${railOn && panel !== null ? " paneled" : ""}`}>
						<div className="chat">{session === null ? <div className="scroll"><div className="col"><Loading /></div></div> : <RootContext.Provider value={env?.root ?? ""}><KeyContext.Provider value={target.key}><WorkContext.Provider value={target.sessionId}><WorkView
								key={`${target.key ?? ""}/${target.sessionId}`}
								session={session}
								auto={launch.auto}
								home={{
									tray: (
										<Tray
											env={env}
											settings={settings}
											onPick={pick}
											onOpen={openFolder}
											onTier={(mode) => void saveSettings({ mode, session: target.sessionId }).then(() => setSettingsBump((n) => n + 1))}
										/>
									),
									guide: settings !== null && (settings.setup === "signin" || settings.setup === "noprofile") ? <Guide settings={settings} onChanged={() => setSettingsBump((n) => n + 1)} /> : null,
								}}
								focusDecision={focusDecision}
								onFocused={() => setFocusDecision(null)}
							/></WorkContext.Provider></KeyContext.Provider></RootContext.Provider>}</div>
						{railOn && panel !== null && session !== null ? (
							<Panels
								kind={panel.kind}
								mode={panel.mode}
								state={session.state}
								wkey={target.key}
								sessionId={target.sessionId}
								focus={panel.focus}
								sidebarOpen={open}
								onFull={() => setPanel({ ...panel, mode: panel.mode === "full" ? "half" : "full" })}
								onClose={() => setPanel(null)}
							/>
						) : null}
					</div>
				)}
			</main>
			{railOn && session !== null ? <Rail state={session.state} env={env} /> : null}
		</div>
		</PanelContext.Provider>
	);
}
