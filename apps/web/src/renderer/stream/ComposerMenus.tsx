import { createContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { SettingsReply } from "../../shared/settings.js";
import { t } from "../i18n/index.js";
import { I } from "./Icons.js";

/** What the composer's pills read and change: this Work's settings, and the calls that change its tier, model and effort. */
export interface Controls {
	readonly settings: SettingsReply | null;
	readonly setTier: (mode: string) => Promise<void>;
	readonly setModel: (patch: { readonly profile?: string; readonly effort?: string }) => Promise<void>;
	/** the files `@` can name in this Work's folder (fetched when the picker first opens) */
	readonly atFiles: () => Promise<readonly string[]>;
	/** choose a folder and add it to this Work (the host's refusal in words, or null) */
	readonly addFolder: () => Promise<string | null>;
	/** changes when the Work's folders do: the `@` list is read again */
	readonly envVersion: number;
}
export const ControlsContext = createContext<Controls | null>(null);

/** A pill and the menu it opens above itself (below it, `down`); a click outside or Esc closes it. */
export function Menu({ label, className, act, disabled, title, down, children }: { readonly label: ReactNode; readonly className?: string; readonly act: string; readonly disabled?: boolean; readonly title?: string; readonly down?: boolean; readonly children: (close: () => void) => ReactNode }): ReactNode {
	const [open, setOpen] = useState(false);
	const box = useRef<HTMLSpanElement>(null);
	useEffect(() => {
		if (!open) return;
		const away = (e: MouseEvent): void => void (box.current?.contains(e.target as Node) === false && setOpen(false));
		const key = (e: KeyboardEvent): void => void (e.key === "Escape" && setOpen(false));
		addEventListener("mousedown", away);
		addEventListener("keydown", key);
		return () => (removeEventListener("mousedown", away), removeEventListener("keydown", key));
	}, [open]);
	return (
		<span className="cm" ref={box}>
			<button type="button" className={`cpill${className === undefined ? "" : ` ${className}`}`} onClick={() => setOpen(!open)} aria-expanded={open} disabled={disabled} title={title} data-act={act}>
				{label}
			</button>
			{open ? (
				<div className={down === true ? "cmenu down" : "cmenu"} role="menu" data-menu={act}>
					{children(() => setOpen(false))}
				</div>
			) : null}
		</span>
	);
}

/** The Work's permission tier: read-only, ask, edits allowed, full access; a change reaches this Work only. */
export function TierMenu({ c }: { readonly c: Controls }): ReactNode {
	const mode = c.settings?.mode ?? "default";
	return (
		<Menu
			act="tier"
			label={<span data-field="tier-pill">{t.tier[mode] ?? mode}</span>}
		>
			{(close) => (
				<>
					<div className="cm-h">{t.tierHead}</div>
					{(c.settings?.modes ?? []).map((m) => (
						<button type="button" key={m.value} className="cm-i" role="menuitemradio" aria-checked={m.value === mode} data-tier={m.value} onClick={() => void c.setTier(m.value).then(close)}>
							<span className="cm-t">
								<b>{t.tier[m.value] ?? m.label}</b>
								<small>{t.tierNote[m.value] ?? ""}</small>
							</span>
							{m.value === mode ? <I.check /> : null}
						</button>
					))}
				</>
			)}
		</Menu>
	);
}

/** The Work's model and effort: the profiles of the shared configuration, and the levels the chosen one's route accepts. */
export function ModelMenu({ c, running }: { readonly c: Controls; readonly running: boolean }): ReactNode {
	const s = c.settings;
	const current = s?.profiles.find((p) => p.name === s.profile) ?? null;
	const effort = s?.effort?.current ?? null;
	// the line names the effort that will be used: the one chosen, else the route's preset
	const shown = effort ?? s?.effort?.default ?? null;
	const [err, setErr] = useState<string | null>(null);
	// a refusal (a run in flight) is said in the menu, never swallowed
	const change = (patch: { readonly profile?: string; readonly effort?: string }, close?: () => void): void =>
		void c.setModel(patch).then(
			() => (setErr(null), close?.()),
			(e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
		);
	return (
		<Menu
			act="model"
			disabled={running || s === null || s.profiles.length === 0}
			{...(running ? { title: t.modelWhileRunning } : {})}
			label={
				<>
					<span data-field="model-pill" title={current?.model}>{current === null ? t.noModel : (current.model.split("/").pop() ?? current.model)}</span>
					{shown !== null ? <span className="sub" data-field="effort-pill">{t.effort[shown] ?? shown}</span> : null}
				</>
			}
		>
			{(close) => (
				<>
					<div className="cm-h">{t.modelHead}</div>
					{/* one line a model, a few lines high: the list scrolls, opened at the one in use */}
					<div className="cm-list" ref={(el) => el?.querySelector("[aria-checked=true]")?.scrollIntoView({ block: "nearest" })}>
						{(s?.profiles ?? []).map((p) => (
							<button type="button" key={p.name} className="cm-i one" role="menuitemradio" aria-checked={p.name === s?.profile} disabled={!p.available} data-profile={p.name} title={p.available ? `${p.model} · ${p.name}` : t.notSignedIn} onClick={() => change({ profile: p.name }, close)}>
								<b>{p.model}</b>
								{p.images === true ? <span className="cm-tag">{t.readsImages}</span> : null}
								<small>{p.available ? p.name : t.notSignedIn}</small>
								{p.name === s?.profile ? <I.check /> : <span className="cm-nock" />}
							</button>
						))}
					</div>
					{s?.effort !== null && s?.effort !== undefined && s.effort.levels.length > 1 ? (
						<>
							<div className="sep" />
							{/* the effort is one row: its level, and a side list of the levels the route accepts */}
							<EffortRow levels={s.effort.levels} current={effort ?? s.effort.default} preset={s.effort.default} onPick={(l) => change({ effort: l })} />
						</>
					) : null}
					{err !== null ? <div className="cm-err" data-kind="model-refused">{err}</div> : null}
				</>
			)}
		</Menu>
	);
}

/** The effort as one row (its level, then a chevron) and the levels in a list beside the menu; it lives as long as the menu. */
function EffortRow({ levels, current, preset, onPick }: { readonly levels: readonly string[]; readonly current: string | null; readonly preset: string | null; readonly onPick: (level: string) => void }): ReactNode {
	const [open, setOpen] = useState(false);
	return (
		<div className="cm-fly">
			<button type="button" className={`cm-i one cm-row${open ? " on" : ""}`} aria-expanded={open} data-act="effort" onClick={() => setOpen(!open)}>
				<b>{t.effortRow}</b>
				<small className="cm-v">{current === null ? "" : (t.effort[current] ?? current)}</small>
				<I.chevron />
			</button>
			{open ? (
				<div className="cmenu cm-sub" role="menu" data-menu="effort">
					{levels.map((l) => (
						<button type="button" key={l} className="cm-i one" role="menuitemradio" aria-checked={l === current} data-effort={l} onClick={() => (onPick(l), setOpen(false))}>
							<b>{t.effort[l] ?? l}</b>
							<small>{l === preset ? t.settingsDefault : ""}</small>
							{l === current ? <I.check /> : <span className="cm-nock" />}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}

/** `@`: the folder's files whose path holds what was typed after it, at most eight; arrows and Enter or a click pick one. */
export function AtPicker({ query, files, active, onPick }: { readonly query: string; readonly files: readonly string[]; readonly active: number; readonly onPick: (path: string) => void }): ReactNode {
	const hits = atHits(files, query);
	return (
		<div className="cmenu atp" role="listbox" data-kind="at-picker">
			{hits.length === 0 ? <div className="cm-h">{t.atNone}</div> : null}
			{hits.map((path, i) => (
				<button type="button" key={path} className={`cm-i${i === active ? " on" : ""}`} role="option" aria-selected={i === active} data-at={path} onMouseDown={(e) => (e.preventDefault(), onPick(path))}>
					<I.file />
					<span className="cm-t">
						<b>{path.split("/").pop()}</b>
						<small>{path}</small>
					</span>
				</button>
			))}
		</div>
	);
}

/** The picker's matches: the path holds the query (any case), the file name's own matches first. */
export const atHits = (files: readonly string[], query: string): readonly string[] => {
	const q = query.toLowerCase();
	const hit = files.filter((f) => f.toLowerCase().includes(q));
	return [...hit.filter((f) => (f.split("/").pop() ?? "").toLowerCase().includes(q)), ...hit.filter((f) => !(f.split("/").pop() ?? "").toLowerCase().includes(q))].slice(0, 8);
};
