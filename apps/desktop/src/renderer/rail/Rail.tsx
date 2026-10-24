import { useState, type ReactNode } from "react";
import type { EnvReply } from "../../shared/settings.js";
import { clock, t, tokens } from "../i18n/index.js";
import type { State } from "../state/model.js";
import { Thumb } from "../stream/Thumb.js";
import { useNow } from "../stream/useNow.js";
import { railOf, type RailStatus } from "./derive.js";
import { Tip, type TipData } from "./Tip.js";

const RING = 100.5;
const STATUS_TEXT: Readonly<Record<RailStatus, string>> = { idle: t.railIdle, working: t.railWorking, waiting: t.railWaiting, done: t.railDone, stopped: t.railStopped, failed: t.railFailed, interrupted: t.railInterrupted };
const money = (usd: number | null): string => (usd === null ? "—" : `$${usd.toFixed(4)}`);
const pct = (n: number | null): string => (n === null ? "—" : `${Math.round(n)}%`);

/**
 * The rail: one slim column that answers "where is this run" at a glance —
 * status and clock, the context ring and the usage line, background tasks,
 * the timeline of steps, what the run produced, and where it runs. Hovering
 * a row opens its detail beside the rail. Every number is read from the
 * stream's state, which is built from the durable log.
 */
export function Rail({ state, env }: { readonly state: State; readonly env: EnvReply | null }): ReactNode {
	const rail = railOf(state);
	const [hover, setHover] = useState<{ readonly tip: TipData; readonly top?: number; readonly bottom?: number } | null>(null);
	const over = (tip: TipData) => ({
		onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
			const r = e.currentTarget.getBoundingClientRect();
			setHover(r.top > innerHeight * 0.55 ? { tip, bottom: Math.max(8, innerHeight - r.bottom - 6) } : { tip, top: Math.max(8, r.top - 6) });
		},
		onMouseLeave: () => setHover(null),
	});
	const live = rail.status === "working" || rail.status === "waiting";
	const now = useNow(live);
	const ms = rail.startedAt === null ? 0 : (rail.endedAt ?? now) - rail.startedAt;
	const u = rail.usage;
	const { tokens: used, window } = state.context;
	const share = used === null || window === null ? null : Math.min(100, (used / window) * 100);
	const usageTip: TipData = {
		head: t.railUsage,
		rows: [
			[t.railFresh, u?.fresh == null ? "—" : u.fresh.toLocaleString()],
			[t.railOutput, u?.output == null ? "—" : u.output.toLocaleString()],
			[t.railCache, pct(u?.cacheRate ?? null)],
			[t.railCost, money(u?.costUsd ?? null)],
			[t.railCalls, String(u?.calls ?? 0)],
		],
	};
	return (
		<aside className="rail" data-kind="rail">
			<div className="rail-h" />
			<div className="rail-b">
				<div className="r-status" data-field="status" {...over(usageTip)}>
					<span className={`pulse ${rail.status}`} />
					<b>{STATUS_TEXT[rail.status]}</b>
					<span className="grow" />
					<span className="clk" data-field="clock">
						{clock(ms)}
					</span>
				</div>
				<div
					className="r-line"
					data-field="context"
					{...over({
						head: t.railContext,
						rows: [
							[t.railUsed, used === null ? "—" : `${used.toLocaleString()}`],
							[t.railWindow, window === null ? t.railUnstated : window.toLocaleString()],
						],
						note: t.railCompactNote,
					})}
				>
					<svg width="26" height="26" viewBox="0 0 40 40">
						<circle cx="20" cy="20" r="16" fill="none" stroke="#ececef" strokeWidth="5" />
						<circle cx="20" cy="20" r="16" fill="none" stroke="var(--blue)" strokeWidth="5" strokeLinecap="round" strokeDasharray={RING} strokeDashoffset={RING * (1 - (share ?? 0) / 100)} transform="rotate(-90 20 20)" />
					</svg>
					<span>{t.railContext}</span>
					<b data-field="context-pct">{share === null ? "?" : `${Math.round(share)}%`}</b>
				</div>
				<div className="r-use mono" data-field="usage" {...over(usageTip)}>
					{u === null ? "0 · $0" : `${tokens((u.fresh ?? 0) + (u.output ?? 0))} · ${money(u.costUsd)}`}
				</div>
				<div className="r-sec">{t.railTasks}</div>
				{state.tasks.length === 0 ? <div className="empty">{t.railNoTasks}</div> : null}
				{state.tasks.map((task) => (
					<div className="tli" key={task.id} data-field="task" {...over({ head: task.command, log: task.tail, rows: [[t.railState, task.label]] })}>
						<div className="t1">
							<b>{task.command}</b>
							<small>{clock(task.elapsedMs)}</small>
						</div>
						<div className={`bar${task.endedAt === null ? " live" : ""}`}>
							<b />
						</div>
					</div>
				))}
				<div className="r-sec">{t.railSteps}</div>
				<div className="tl">
					{rail.steps.length === 0 ? <div className="empty">{t.railNoSteps}</div> : null}
					{rail.steps.map((s) => (
						<div className={`tli ${s.status}`} key={s.id} data-field="step" {...over({ head: s.title, log: s.lines, rows: s.ms === null ? [] : [[t.railTook, `${(s.ms / 1000).toFixed(1)} s`]] })}>
							<span className="nd" />
							<div className="t1">
								<b>{s.title}</b>
								<small>{s.at === null ? "" : clock(s.at)}</small>
							</div>
						</div>
					))}
				</div>
				<div className="r-sec">{t.railOutputs}</div>
				{rail.outputs.length === 0 ? <div className="empty">{t.railNoOutputs}</div> : null}
				<div className="outs">
					{rail.outputs.map((o) => (
						<div className="out" key={o.id} data-field="output" {...over({ head: o.name, note: o.sub, big: <Thumb kind={o.kind} /> })}>
							<div className="oprev">
								<Thumb kind={o.kind} />
							</div>
							<div className="nm">{o.name}</div>
						</div>
					))}
				</div>
			</div>
			<div className="rail-f">
				{env === null ? null : (
					<div className="envcol" data-field="env" {...over({ head: t.railEnv, rows: [[t.railPath, env.path], ...(env.branch === null ? [] : ([[t.railBranch, env.branch]] as const))] })}>
						<span>{env.folder}</span>
						{env.branch === null ? null : <span>{env.branch}</span>}
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

