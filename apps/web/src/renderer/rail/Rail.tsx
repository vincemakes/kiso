import { useState, type ReactNode } from "react";
import type { ContextParts, EnvReply } from "../../shared/settings.js";
import type { GitReply } from "../../shared/git.js";
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
	/** the folder's changes from git (null: not read yet); outside git the rail falls back to the Work's own edits from the log */
	readonly git: GitReply | null;
	/** what the Work's requests always carry, for the Context breakdown (null: not read yet) */
	readonly parts: ContextParts | null;
	readonly onCommit: () => void;
	readonly onPr: () => void;
}

/** Tokens estimated from bytes (about four bytes a token for English and code): the breakdown says it is an estimate. */
const est = (bytes: number): number => Math.round(bytes / 4);
const pctOf = (n: number, of: number | null): string => (of === null || of === 0 ? "" : `${((n / of) * 100).toFixed(1)}%`);

/**
 * The rail: one column of hairline sections, glanceable, no cards. Context (folded to one row and a bar), the background tasks
 * (only when there are any; the finished ones folded into one row), the files this Work changed and its branch, everything it made
 * (opened the one way the stream opens them), and where it runs. It carries no state of the run itself: the stream shows the live
 * step, and the composer stops a run. Every number is read from the stream's state, built from the durable log.
 */
export function Rail({ state, env, onStopTask, git, parts, onCommit, onPr }: Props): ReactNode {
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
	// a profile that states no window is drawn against 200k, the common window (owner 2026-11-02: a number reads better than "?")
	const { tokens: used, window: stated } = state.context;
	const window = stated ?? 200_000;
	const share = used === null ? 0 : Math.min(100, (used / window) * 100);
	const live = state.tasks.filter((x) => x.endedAt === null);
	const done = state.tasks.filter((x) => x.endedAt !== null);
	const changes = workChangesOf(state, env?.root ?? null);
	const g = git?.repo === true ? git : null;
	const rows = g !== null ? g.files.map((f) => ({ path: f.path, added: f.added ?? 0, removed: f.removed ?? 0, created: f.state === "new", exact: f.added !== null, deleted: f.state === "deleted" })) : changes.map((c) => ({ ...c, deleted: false }));
	// the Context breakdown: the parts every request carries (estimated from bytes), the conversation as the measured rest, the free room
	const fixed = parts === null ? null : [
		{ key: "system", name: t.ctxSystem, tokens: est(parts.system) },
		...(parts.instructions > 0 ? [{ key: "instructions", name: t.ctxInstructions, tokens: est(parts.instructions) }] : []),
		{ key: "tools", name: fmt(t.ctxTools, { n: parts.tools.count }), tokens: est(parts.tools.bytes) },
	];
	const segments = fixed === null || used === null ? null : [{ key: "conversation", name: t.ctxConversation, tokens: Math.max(0, used - fixed.reduce((n, f) => n + f.tokens, 0)) }, ...fixed];
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
				<div className="rail-h">{t.overview}</div>
				<div className="rail-b">
					<section className={`r-sec r-ctx${folded["context"] ? " closed" : ""}`} data-section="context">
						<button className="r-sh" onClick={toggle("context")} aria-expanded={!folded["context"]} data-act="fold-context" data-field="context">
							<span className="r-ic r-chev">
								<I.chevron />
							</span>
							<b>{t.railContext}</b>
							<span className="grow" />
							<span className="r-ctxv">
								<b data-field="context-pct">{Math.round(share)}%</b> · {tokens(used ?? 0)} / {window % 1000 === 0 ? `${window / 1000}k` : tokens(window)}
							</span>
						</button>
						<div className="r-meter" aria-hidden="true">
							{segments !== null && window !== null ? segments.map((x) => <b key={x.key} className={`seg-${x.key}`} style={{ width: `${(x.tokens / window) * 100}%` }} />) : <b style={{ width: `${share ?? 0}%` }} />}
							{parts?.compaction != null && window !== null ? (
								<>
									<i className="tick soft" style={{ left: `${(parts.compaction.starts / window) * 100}%` }} title={t.ctxStarts} />
									<i className="tick" style={{ left: `${(parts.compaction.must / window) * 100}%` }} title={t.ctxMust} />
								</>
							) : null}
						</div>
						{folded["context"] ? null : (
							<div className="r-kv" data-field="context-detail">
								{segments === null ? null : (
									<div className="r-parts" data-field="context-parts">
										{segments.map((x) => (
											<div key={x.key} className="r-part" data-part={x.key}>
												<i className={`sw seg-${x.key}`} />
												<span title={x.name}>{x.name}</span>
												<b>≈{tokens(x.tokens)}</b>
												<em>{pctOf(x.tokens, window)}</em>
											</div>
										))}
										{window !== null && used !== null ? (
											<div className="r-part" data-part="free">
												<i className="sw seg-free" />
												<span title={t.ctxFree}>{t.ctxFree}</span>
												<b>{tokens(Math.max(0, window - used))}</b>
												<em>{pctOf(Math.max(0, window - used), window)}</em>
											</div>
										) : null}
										{parts?.compaction != null ? <small>{fmt(t.ctxCompaction, { starts: tokens(parts.compaction.starts), must: tokens(parts.compaction.must) })}</small> : null}
										<small>{t.ctxEstimate}</small>
									</div>
								)}
								<span>{t.railUsed}</span>
								<b>{used === null ? "—" : used.toLocaleString()}</b>
								<span>{t.railWindow}</span>
								<b>{stated === null ? `${window.toLocaleString()} ${t.railUnstated}` : window.toLocaleString()}</b>
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
					{rows.length === 0 && (g?.branch ?? env?.branch ?? null) === null ? null : (
						<Section
							id="changes"
							name={t.railChanges}
							count={rows.length}
							extra={
								<span className="r-mt">
									<span className="add">+{rows.reduce((n, c) => n + c.added, 0)}</span> <span className="del">−{rows.reduce((n, c) => n + c.removed, 0)}</span>
								</span>
							}
							open={!folded["changes"]}
							onToggle={toggle("changes")}
						>
							{(g?.branch ?? env?.branch ?? null) === null ? null : (
								<div className="r-row r-br" data-field="branch-row">
									<span className="r-ic">
										<I.branch />
									</span>
									<span className="r-nm mono" data-field="branch">{g?.branch ?? env?.branch}</span>
									{g?.base != null && g.base !== g.branch ? <span className="r-mt">→ {g.base}{g.ahead > 0 ? ` ↑${g.ahead}` : ""}</span> : null}
									{g === null || g.pr !== null ? null : g.dirty ? (
										<button className="r-act" onClick={onCommit} data-act="commit">
											{t.commitOpen}
										</button>
									) : g.canPr && g.ahead > 0 ? (
										<button className="r-act" onClick={onPr} data-act="create-pr">
											{t.prOpen}
										</button>
									) : null}
								</div>
							)}
							{g?.pr == null ? null : (
								<a className="r-row r-pr" href={g.pr.url} target="_blank" rel="noreferrer" data-field="pr" title={g.pr.title}>
									<span className="r-ic">
										<I.pr />
									</span>
									<span className="r-nm">
										#{g.pr.number} {g.pr.title}
									</span>
									<span className={`r-ci${g.pr.checks.failed > 0 ? " bad" : g.pr.checks.done < g.pr.checks.total ? " run" : ""}`} data-field="pr-checks">
										{g.pr.state === "MERGED" ? t.prMerged : g.pr.checks.total === 0 ? "" : `${g.pr.checks.done}/${g.pr.checks.total}`}
									</span>
								</a>
							)}
							{rows.map((c) => (
								<div className="r-row" key={c.path} data-field="change" title={c.path} onClick={() => openPanel("diff")}>
									<span className="r-ic">{artifactIcon("file", c.path)}</span>
									<span className="r-nm">{c.path.split("/").pop()}</span>
									<span className="r-mt">{c.deleted ? t.gitState.deleted : c.created ? t.railNew : c.exact ? <><span className="add">+{c.added}</span> <span className="del">−{c.removed}</span></> : t.deltaModified}</span>
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
