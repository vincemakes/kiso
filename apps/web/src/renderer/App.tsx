import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { Sidebar } from "./sidebar/Sidebar.js";
import { Mark, Overview, Sidebar as SidebarIcon } from "./stream/Icons.js";
import { Rail } from "./rail/Rail.js";
import { PanelContext } from "./panels/context.js";
import { Panels } from "./panels/Panels.js";
import { PanelMenu } from "./panels/Menu.js";
import type { PanelKind, PanelMode } from "./state/panels.js";
import { isLive } from "./state/model.js";
import { RootContext } from "./stream/root.js";
import { ForkContext, KeyContext, WorkContext } from "./stream/links.js";
import { Loading, WorkView } from "./stream/WorkView.js";
import { Lightbox, LightboxContext } from "./stream/Lightbox.js";
import { Settings } from "./settings/Settings.js";
import { Guide } from "./home/Guide.js";
import { Tray } from "./home/Tray.js";
import { Folders } from "./home/Folders.js";
import { actOnWork, forkWork, renameWork, chooseFolder, fetchAtFiles, fetchContext, fetchGit, fetchPrDraft, fetchSettings, postCommit, linkPr, postPr, saveSettings, sendPresence, stopTask, type OpenWork } from "./state/desk.js";
import { CommitDialog, PrDialog } from "./rail/GitDialogs.js";
import { Header } from "./rail/Header.js";
import type { GitReply } from "../shared/git.js";
import { ControlsContext, type Controls } from "./stream/ComposerMenus.js";
import { signIn } from "./state/auth.js";
import { watchNotices } from "./state/notify.js";
import { launchParams, openSession, type Session } from "./state/store.js";
import { addFolderTo } from "./state/folders.js";
import { fetchEnv, fetchHistory, newWorkId, sessionsUrl, type Target } from "./state/works.js";
import { ago, t } from "./i18n/index.js";
import type { HistoryReply, WorkRow } from "../shared/history.js";
import type { ContextParts, EnvReply, SettingsReply } from "../shared/settings.js";

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
// under 864 px the Work is the whole window: the sidebar and the overview float over it (one at a time), closed until asked for
const NARROW = "(max-width: 863px)";
const isNarrow = (): boolean => matchMedia(NARROW).matches;
const onNarrow = (cb: () => void): (() => void) => {
	const m = matchMedia(NARROW);
	m.addEventListener("change", cb);
	return () => m.removeEventListener("change", cb);
};

export function App(): ReactNode {
	// null while the page trades its connect code; false: no session (the page shows one line, "run kiso web")
	const [signedIn, setSignedIn] = useState<boolean | null>(null);
	useEffect(() => void signIn(launch.code).then(setSignedIn), []);
	const [open, setOpen] = useState(false);
	const narrow = useSyncExternalStore(onNarrow, isNarrow);
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
	const [railChoice, setRailChoice] = useState(() => !isNarrow());
	// narrow: both float closed when the window gets narrow and when another Work is opened; a tap on the veil closes the one open
	useEffect(() => {
		if (narrow) (setOpen(false), setRailChoice(false));
	}, [narrow, target]);

	useEffect(() => {
		if (signedIn !== true) return;
		const next = openSession({ baseUrl: sessionsUrl(location.origin, target.key), sessionId: target.sessionId, onRefused: () => setSignedIn(false) });
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
	// the rail's Changes from git and the Context parts: read when the Work or its settings change and when a run ends; a pull
	// request whose checks are still running is read again every 20 s
	const [git, setGit] = useState<GitReply | null>(null);
	const [parts, setParts] = useState<ContextParts | null>(null);
	const [dialog, setDialog] = useState<"commit" | "pr" | null>(null);
	const refreshGit = useCallback(() => void fetchGit(target.key).then(setGit, () => setGit(null)), [target.key]);
	const lastPhase = session?.state.turns.at(-1)?.phase ?? null;
	const turns = session?.state.turns.length ?? 0;
	useEffect(() => {
		if (signedIn !== true || view !== "work") return;
		refreshGit();
		void fetchContext(target.key, target.sessionId).then(setParts, () => setParts(null));
	}, [target, view, signedIn, settingsBump, settings, lastPhase, turns, refreshGit]);
	const pending = git?.pr != null && git.pr.state === "OPEN" && git.pr.checks.done < git.pr.checks.total;
	useEffect(() => {
		if (!pending) return;
		const timer = setInterval(refreshGit, 20_000);
		return () => clearInterval(timer);
	}, [pending, refreshGit]);
	const prOfRow = useCallback((row: WorkRow) => fetchGit(row.key === history?.current.key ? null : row.key).then((g) => (g.pr !== null && g.pr.state === "OPEN" ? { number: g.pr.number, url: g.pr.url } : null)), [history?.current.key]);
	const prDraft = useCallback(() => fetchPrDraft(target.key), [target.key]);
	useEffect(() => {
		if (started && !shown && history !== null) refresh(target.key ?? history.current.key);
	}, [started, shown, version, target, history === null, refresh]);

	useEffect(() => {
		if (view === "work" && signedIn === true) void fetchEnv(target.key, target.sessionId).then(setEnv, () => undefined);
	}, [target, view, settingsBump, signedIn, lastPhase]);
	const railOn = started && view === "work";
	// an open panel takes the rail's place; closing it gives the rail back
	const railOpen = railOn && railChoice && panel === null;
	const [lightbox, setLightbox] = useState<string | null>(null);
	const closeLightbox = useCallback(() => setLightbox(null), []);
	// the composer's pills: this Work's tier, model and effort, changed for this Work only (its folder's key, so its own space rebuilds it)
	const controls = useMemo<Controls>(
		() => ({
			settings,
			setTier: (mode) => saveSettings({ mode, session: target.sessionId }, target.key).then((r) => (setSettings(r), setSettingsBump((n) => n + 1))),
			setModel: (patch) => saveSettings({ ...patch, session: target.sessionId }, target.key).then((r) => setSettings(r)),
			atFiles: () => fetchAtFiles(target.key, target.sessionId).then((r) => r.files),
			envVersion: settingsBump,
			addFolder: () => addFolderTo(target.key, target.sessionId).then((m) => (setSettingsBump((n) => n + 1), m)),
		}),
		[settings, target],
	);
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
	const rows: readonly WorkRow[] = (history?.works ?? []).map((w) => (w.id === target.sessionId && w.key === activeKey ? (({ unread: _, ...rest }) => ({ ...rest, state: ownState }))(w) : w));
	// the header: the Work's name (a rename shows at once, the listing catches up), else its first request (the folder and branch are in the overview)
	const [named, setNamed] = useState<Readonly<Record<string, string>>>({});
	const row = rows.find((w) => w.id === target.sessionId && w.key === activeKey);
	const title = named[target.sessionId] ?? row?.title ?? session?.state.turns[0]?.user.split("\n")[0] ?? "";
	// a name shows at once; a cleared one waits for the listing, which reads names live, to give back the first-request title
	// a row's folder key as the routes take it (null: the folder in use), and the listing read again for that folder
	const keyOf = (row: WorkRow): string | null => (row.key === history?.current.key ? null : row.key);
	const reread = (key: string | undefined): Promise<void> => fetchHistory(key).then(setHistory, () => undefined);
	const renameRow = (key: string | null, id: string, name: string): Promise<void> =>
		renameWork(key, id, name).then((r) => {
			setNamed(({ [id]: _, ...n }) => (r.name === null ? n : { ...n, [id]: r.name }));
			return reread(key ?? history?.current.key);
		});
	const onRename = (name: string): Promise<void> => renameRow(target.key, target.sessionId, name);
	const header =
		railOn && session !== null ? (
			<Header title={title} onRename={onRename}>
				<button className={`railtoggle${railOpen ? " on" : ""}`} onClick={() => (narrow && setOpen(false), panel !== null ? (setPanel(null), setRailChoice(true)) : setRailChoice(!railChoice))} aria-label={t.overview} aria-pressed={railOpen} data-act="rail">
					<Overview />
				</button>
				<PanelMenu onPick={openPanel} />
			</Header>
		) : null;
	// fork: the new Work opens at once; a refusal is said in the Work it was asked in
	const [forkError, setForkError] = useState<string | null>(null);
	useEffect(() => setForkError(null), [target]);
	const onFork = useCallback(
		(atSeq: number) =>
			void forkWork(target.key, target.sessionId, atSeq).then(
				(r) => {
					setTarget({ key: target.key, sessionId: r.id });
					void fetchHistory(target.key ?? history?.current.key).then(setHistory, () => undefined);
				},
				(e: Error) => setForkError(e.message),
			),
		[target, history?.current.key],
	);
	const parentRow = env?.fork === undefined ? undefined : rows.find((w) => w.id === env.fork?.parent && w.key === activeKey);
	const lead =
		forkError !== null ? (
			<div className="forknote err" data-kind="fork-error">{forkError}</div>
		) : env?.fork !== undefined ? (
			<div className="forknote" data-kind="fork-note">
				{t.forkedFrom}{" "}
				{parentRow === undefined ? (
					<b data-field="fork-parent-gone">{env.fork.title || t.untitled}</b>
				) : (
					<button className="flink" data-act="fork-parent" onClick={() => setTarget({ key: target.key, sessionId: env.fork!.parent })}>
						{parentRow.title || env.fork.title || t.untitled}
					</button>
				)}{" "}
				· {ago(env.fork.at, Date.now())}. {t.forkShared}
			</div>
		) : null;
	const openWork = (row: WorkRow): void => {
		setView("work");
		setTarget({ key: row.key === history?.current.key ? null : row.key, sessionId: row.id });
	};
	if (signedIn === false) return <div className="signedout" data-kind="signedout">{t.signedOut}</div>;
	return (
		<PanelContext.Provider value={openPanel}>
		<LightboxContext.Provider value={setLightbox}>
		<ControlsContext.Provider value={controls}>
		<div className="win" onClick={(e) => { if (narrow && e.target === e.currentTarget) (setOpen(false), setRailChoice(false)); }} data-side={open ? "1" : "0"} data-rail={railOpen ? "1" : "0"} data-panel={railOn && panel !== null ? panel.mode : "closed"}>
			{browsing ? <Folders onChoose={openFolder} onClose={() => setBrowsing(false)} /> : null}
			{/* the brand: the mark and the word at the top of the open sidebar, nothing beside the toggle with it closed; a click does nothing (New task is the button below it) */}
			{open ? (
				<div className="brand" data-kind="brand">
					<Mark />
					<span className="word">kiso</span>
				</div>
			) : null}
			<button className="sidetoggle" onClick={() => (narrow && !open && setRailChoice(false), setOpen(!open))} aria-label={open ? t.closeSidebar : t.openSidebar} data-act="sidebar">
				<SidebarIcon />
			</button>
			<Sidebar
				works={rows}
				active={{ key: activeKey, id: target.sessionId }}
				settingsOn={view === "settings"}
				onOpen={openWork}
				onAct={(row, act) =>
					actOnWork(keyOf(row), row.id, act).then(() => {
						if (act === "delete" && row.id === target.sessionId) setTarget({ key: null, sessionId: newWorkId() });
						return reread(row.key);
					})
				}
				onRename={(row, name) => renameRow(keyOf(row), row.id, name)}
				onLinkPr={(row, pr) => linkPr(keyOf(row), row.id, pr).then(() => reread(row.key))}
				onFork={(row) =>
					void forkWork(keyOf(row), row.id).then(
						(r) => {
							setView("work");
							setTarget({ key: keyOf(row), sessionId: r.id });
							void reread(row.key);
						},
						(e: Error) => setForkError(e.message),
					)
				}
				prOf={prOfRow}
				onNew={() => {
					setView("work");
					setTarget({ key: null, sessionId: newWorkId() });
				}}
				onNewIn={(key) => goTo(key, newWorkId())}
				onSettings={() => setView("settings")}
			/>
			<main className="main">
				{view === "settings" ? (
					<Settings />
				) : (
					<div className={`work${railOn && panel !== null ? " paneled" : ""}`}>
						<div className="chat">{header}{session === null ? <div className="scroll"><div className="col"><Loading /></div></div> : <RootContext.Provider value={env?.root ?? ""}><KeyContext.Provider value={target.key}><WorkContext.Provider value={target.sessionId}><ForkContext.Provider value={onFork}><WorkView
								key={`${target.key ?? ""}/${target.sessionId}`}
								session={session}
								auto={launch.auto}
								home={{
									tray: (
										<Tray
											env={env}
											onPick={pick}
											onOpen={openFolder}
										/>
									),
									guide: settings !== null && (settings.setup === "signin" || settings.setup === "noprofile") ? <Guide settings={settings} onChanged={() => setSettingsBump((n) => n + 1)} /> : null,
								}}
								focusDecision={focusDecision}
								onFocused={() => setFocusDecision(null)}
								lead={lead}
							/></ForkContext.Provider></WorkContext.Provider></KeyContext.Provider></RootContext.Provider>}</div>
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
			{railOn && session !== null ? <Rail state={session.state} env={env} session={target.sessionId} where={target.key} onEnvChanged={() => setSettingsBump((n) => n + 1)} git={git} parts={parts} onCommit={() => setDialog("commit")} onPr={() => setDialog("pr")} onStopTask={(id) => void stopTask(target.key, target.sessionId, id)} /> : null}
			{dialog === "commit" && git?.branch != null ? (
				<CommitDialog
					branch={git.branch}
					files={git.files.filter((f) => f.dirty)}
					draft={(session?.state.turns.at(-1)?.user ?? "").split("\n")[0]!.slice(0, 72)}
					onCommit={(message, paths) => postCommit(target.key, message, paths).then(() => (setDialog(null), refreshGit()))}
					onCancel={() => setDialog(null)}
				/>
			) : null}
			{dialog === "pr" && git?.branch != null && git.base !== null ? (
				<PrDialog branch={git.branch} base={git.base} ahead={git.ahead} draft={prDraft} onCreate={(title, body) => postPr(target.key, title, body, target.sessionId).then(() => (setDialog(null), refreshGit()))} onCancel={() => setDialog(null)} />
			) : null}
			{lightbox !== null ? (
				<KeyContext.Provider value={target.key}>
					<Lightbox focus={lightbox} onClose={closeLightbox} />
				</KeyContext.Provider>
			) : null}
		</div>
		</ControlsContext.Provider>
		</LightboxContext.Provider>
		</PanelContext.Provider>
	);
}
