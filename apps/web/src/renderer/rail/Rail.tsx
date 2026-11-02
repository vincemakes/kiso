import { useState, type ReactNode } from "react";
import type { EnvReply } from "../../shared/settings.js";
import type { TaskRow } from "../../shared/frames.js";
import { clock, fmt, t, tokens } from "../i18n/index.js";
import type { State } from "../state/model.js";
import { useOpenPanel } from "../panels/context.js";
import { artifactIcon, I } from "../stream/Icons.js";
import { useOpenArtifact } from "../stream/Lightbox.js";
import { outputsOf, railOf, workChangesOf } from "./derive.js";
import { Tip, type TipData } from "./Tip.js";

const money = (usd: number | null): string => (usd === null ? "—" : `$${usd.toFixed(4)}`);
const pct = (n: number | null): string => (n === null ? "—" : `${Math.round(n)}%`);
const ago = (ms: number): string => (ms < 60_000 ? t.railNow : ms < 3_600_000 ? `${Math.floor(ms / 60_000)}m` : ms < 86_400_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`);
const SHOWN = 4;

/** A section of the rail: a header that folds it (a 16 px chevron in the icon column, the name, a count, a figure at the right). */
function Section({ id, name, count, extra, open, onToggle, children }: { readonly id: string; readonly name: string; readonly count?: number; readonly extra?: ReactNode; readonly open: boolean; readonly onToggle: () => void; readonly children: ReactNode }): ReactNode {
	return (
		<section className={`r-sec${open ? "" : " closed"}`} data-section={id}>
			<button className="r-sh" onClick={onToggle} aria-expanded={open} data-act={`fold-${id}`}>
				<span className="r-ic r-chev">
					<I.chevron />
				</span>
				<b>{name}</b>
				{count !== undefined ? <span className="r-cnt">{count}</span> : null}
				<span className="grow" />
				{extra}
			</button>
			{open ? <div className="r-bd">{children}</div> : null}
		</section>
	);
}

interface Props {
	readonly state: State;
	readonly env: EnvReply | null;
	readonly onStopTask: (id: string) => void;
}

/**
 * The rail: one column of hairline sections, glanceable, no cards. Context (folded to one row and a bar), the background tasks
 * (only when there are any; the finished ones folded into one row), the files this Work changed and its branch, everything it made
 * (opened the one way the stream opens them), and where it runs. It carries no state of the run itself: the stream shows the live
 * step, and the composer stops a run. Every number is read from the stream's state, built from the durable log.
 */
export function Rail({ state, env, onStopTask }: Props): ReactNode {
	const rail = railOf(state);
	const openPanel = useOpenPanel();
	const openArtifact = useOpenArtifact();
	const [hover, setHover] = useState<{ readonly tip: TipData; readonly top?: number; readonly bottom?: number } | null>(null);
	const [folded, setFolded] = useState<Readonly<Record<string, boolean>>>({ context: true });
	const [finished, setFinished] = useState(false);
	const [allOutputs, setAllOutputs] = useState(false);
	const toggle = (id: string) => () => setFolded((f) => ({ ...f, [id]: !f[id] }));
	const over = (tip: TipData) => ({
		onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
			const r = e.currentTarget.getBoundingClientRect();
			setHover(r.top > innerHeight * 0.55 ? { tip, bottom: Math.max(8, innerHeight - r.bottom - 6) } : { tip, top: Math.max(8, r.top - 6) });
		},
		onMouseLeave: () => setHover(null),
	});
	const u = rail.usage;
	const { tokens: used, window } = state.context;
	const share = used === null || window === null ? null : Math.min(100, (used / window) * 100);
	const live = state.tasks.filter((x) => x.endedAt === null);
	const done = state.tasks.filter((x) => x.endedAt !== null);
	const changes = workChangesOf(state, env?.root ?? null);
	const outputs = outputsOf(state);
	const now = Date.now();
	const task = (x: TaskRow): ReactNode => (
		<div className={`r-row${x.endedAt === null ? "" : " dim"}`} key={x.id} data-field="task" onClick={() => openPanel("term", x.id)} {...over({ head: x.command, log: x.tail, rows: [[t.railState, x.label]] })}>
			<span className="r-ic">
				<I.term />
			</span>
			<span className="r-nm mono">{x.command}</span>
			<span className="r-mt">{clock(x.elapsedMs)}</span>
			{x.endedAt === null ? (
				<button
					className="r-stop"
					aria-label={t.stopTask}
					title={t.stopTask}
					data-act="task-stop"
					onClick={(e) => {
						e.stopPropagation();
						onStopTask(x.id);
					}}
				>
					<i />
				</button>
			) : null}
		</div>
	);
	return (
		<aside className="rail" data-kind="rail">
			<div className="rail-in">
				<div className="rail-h" />
				<div className="rail-b">
					<section className={`r-sec r-ctx${folded["context"] ? " closed" : ""}`} data-section="context">
						<button className="r-sh" onClick={toggle("context")} aria-expanded={!folded["context"]} data-act="fold-context" data-field="context">
							<span className="r-ic r-chev">
								<I.chevron />
							</span>
							<b>{t.railContext}</b>
							<span className="grow" />
							<span className="r-ctxv">
								<b data-field="context-pct">{share === null ? "?" : `${Math.round(share)}%`}</b> · {tokens(used)} / {window === null ? "?" : tokens(window)}
							</span>
						</button>
						<div className="r-meter" aria-hidden="true">
							<b style={{ width: `${share ?? 0}%` }} />
						</div>
						{folded["context"] ? null : (
							<div className="r-kv" data-field="context-detail">
								<span>{t.railUsed}</span>
								<b>{used === null ? "—" : used.toLocaleString()}</b>
								<span>{t.railWindow}</span>
								<b>{window === null ? t.railUnstated : window.toLocaleString()}</b>
								<span>{t.railFresh}</span>
								<b data-field="usage-fresh">{u?.fresh == null ? "—" : u.fresh.toLocaleString()}</b>
								<span>{t.railOutput}</span>
								<b data-field="usage-output">{u?.output == null ? "—" : u.output.toLocaleString()}</b>
								<span>{t.railCache}</span>
								<b data-field="usage-cache">{pct(u?.cacheRate ?? null)}</b>
								<span>{t.railCost}</span>
								<b data-field="usage-cost">{money(u?.costUsd ?? null)}</b>
								<span>{t.railCalls}</span>
								<b data-field="usage-calls">{String(u?.calls ?? 0)}</b>
								<small>{t.railCompactNote}</small>
							</div>
						)}
					</section>
					{state.tasks.length === 0 ? null : (
						<Section id="tasks" name={t.railTasks} {...(live.length > 0 ? { count: live.length } : {})} open={!folded["tasks"]} onToggle={toggle("tasks")}>
							{live.map(task)}
							{done.length === 0 ? null : (
								<button className="r-row dim" onClick={() => setFinished(!finished)} aria-expanded={finished} data-act="finished">
									<span className="r-ic">
										<I.check />
									</span>
									<span className="r-nm">{fmt(t.railFinished, { n: done.length })}</span>
									<span className={`r-ic r-chev${finished ? "" : " side"}`}>
										<I.chevron />
									</span>
								</button>
							)}
							{finished ? done.map(task) : null}
						</Section>
					)}
					{changes.length === 0 && (env?.branch ?? null) === null ? null : (
						<Section
							id="changes"
							name={t.railChanges}
							count={changes.length}
							extra={
								<span className="r-mt">
									<span className="add">+{changes.reduce((n, c) => n + c.added, 0)}</span> <span className="del">−{changes.reduce((n, c) => n + c.removed, 0)}</span>
								</span>
							}
							open={!folded["changes"]}
							onToggle={toggle("changes")}
						>
							{env?.branch == null ? null : (
								<div className="r-row r-br" data-field="branch">
									<span className="r-ic">
										<I.branch />
									</span>
									<span className="r-nm mono">{env.branch}</span>
								</div>
							)}
							{changes.map((c) => (
								<div className="r-row" key={c.path} data-field="change" title={c.path} onClick={() => openPanel("diff")}>
									<span className="r-ic">{artifactIcon("file", c.path)}</span>
									<span className="r-nm">{c.path.split("/").pop()}</span>
									<span className="r-mt">{c.created ? t.railNew : c.exact ? <><span className="add">+{c.added}</span> <span className="del">−{c.removed}</span></> : t.deltaModified}</span>
								</div>
							))}
						</Section>
					)}
					{outputs.length === 0 ? null : (
						<Section id="outputs" name={t.railOutputs} count={outputs.length} open={!folded["outputs"]} onToggle={toggle("outputs")}>
							{(allOutputs ? outputs : outputs.slice(0, SHOWN)).map((o) => (
								<div className="r-row" key={o.focus} data-field="output" data-artifact={o.focus} title={o.focus.startsWith("log:") ? t.imageResult : o.focus} onClick={() => openArtifact(o.a)}>
									<span className="r-ic">{artifactIcon(o.a.kind, o.focus)}</span>
									<span className="r-nm">{o.focus.startsWith("log:") ? t.imageResult : o.focus.split("/").pop()}</span>
									<span className="r-mt">{o.at === null ? "" : ago(now - o.at)}</span>
								</div>
							))}
							{outputs.length > SHOWN && !allOutputs ? (
								<button className="r-row dim" onClick={() => setAllOutputs(true)} data-act="more-outputs">
									<span className="r-ic" />
									<span className="r-nm">{fmt(t.railShowMore, { n: outputs.length - SHOWN })}</span>
								</button>
							) : null}
						</Section>
					)}
				</div>
				{env === null ? null : (
					<div className="r-env" data-field="env" {...over({ head: t.railEnv, rows: [[t.railPath, env.path], ...(env.branch === null ? [] : ([[t.railBranch, env.branch]] as const))] })}>
						<span className="r-ic">
							<I.folder />
						</span>
						<span className="r-env-f">{env.folder}</span>
						{env.branch === null ? null : (
							<>
								<span className="r-ic">
									<I.branch />
								</span>
								<span className="r-env-b mono">{env.branch}</span>
							</>
						)}
						<span className="chip2" data-field="tier">
							{t.tier[env.mode] ?? env.mode}
						</span>
					</div>
				)}
			</div>
			<Tip tip={hover?.tip ?? null} {...(hover?.top !== undefined ? { top: hover.top } : {})} {...(hover?.bottom !== undefined ? { bottom: hover.bottom } : {})} />
		</aside>
	);
}
