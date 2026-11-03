import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { notifyState, turnOff, turnOn, type NotifyState } from "../state/notify.js";
import type { SettingsPatch, SettingsReply } from "../../shared/settings.js";
import { Menu, TIER_CLASS } from "../stream/ComposerMenus.js";
import { I } from "../stream/Icons.js";

/** A field's pill: what is chosen, and the chevron that says it opens (the composer's menus, opening down). */
const pill = (text: string, field: string): ReactNode => (
	<>
		<span data-field={field}>{text}</span>
		<I.chevron />
	</>
);

async function call(patch?: SettingsPatch): Promise<SettingsReply> {
	const response = await fetch("/desk/settings", {
		method: patch === undefined ? "GET" : "POST",
		...(patch === undefined ? {} : { body: JSON.stringify(patch) }),
	});
	if (!response.ok) throw new Error(`settings ${response.status}`);
	return (await response.json()) as SettingsReply;
}

function Row({ label, note, children }: { readonly label: string; readonly note?: string; readonly children: ReactNode }): ReactNode {
	return (
		<div className="srow">
			<div className="slabel">
				{label}
				{note === undefined ? null : <small>{note}</small>}
			</div>
			<div className="sfield">{children}</div>
		</div>
	);
}

/** The minimal Settings: the model and its effort, the permission tier, the sign-in status. A change reaches Works opened after it (the tier, every Work). */
export function Settings(): ReactNode {
	const [s, setS] = useState<SettingsReply | null>(null);
	useEffect(() => {
		void call().then(setS, () => undefined);
	}, []);
	const change = (patch: SettingsPatch): void => void call(patch).then(setS, () => undefined);
	const [notify, setNotify] = useState<NotifyState>(notifyState);
	if (s === null) return <div className="settings" />;
	const current = s.profiles.find((p) => p.name === s.profile) ?? null;
	const effort = s.effort === null ? "" : (s.effort.current ?? s.effort.default ?? "");
	return (
		<div className="settings" data-kind="settings">
			<h1>{t.settings}</h1>
			<Row label={t.settingsModel} note={t.settingsModelNote}>
				{s.profiles.length === 0 ? (
					<span className="muted">{t.settingsNoModel}</span>
				) : (
					<Menu act="profile" down label={pill(current?.model ?? "—", "profile")}>
						{(close) =>
							s.profiles.map((p) => (
								<button type="button" key={p.name} className="cm-i one" role="menuitemradio" aria-checked={p.name === s.profile} disabled={!p.available} data-profile={p.name} title={`${p.model} · ${p.name}`} onClick={() => (change({ profile: p.name }), close())}>
									<b>{p.model}</b>
									{p.images ? <span className="cm-tag">{t.readsImages}</span> : null}
									<small>{p.available ? p.name : t.settingsNotSignedIn}</small>
									{p.name === s.profile ? <I.check /> : <span className="cm-nock" />}
								</button>
							))
						}
					</Menu>
				)}
			</Row>
			<Row label={t.settingsEffort} note={t.settingsEffortNote}>
				{s.effort === null ? (
					<span className="muted">{t.settingsEffortUnknown}</span>
				) : (
					<Menu act="effort" down label={pill(t.effort[effort] ?? effort, "effort")}>
						{(close) =>
							s.effort!.levels.map((level) => (
								<button type="button" key={level} className="cm-i one" role="menuitemradio" aria-checked={level === effort} data-effort={level} onClick={() => (change({ effort: level }), close())}>
									<b>{t.effort[level] ?? level}</b>
									<small>{level === s.effort!.default ? t.settingsDefault : ""}</small>
									{level === effort ? <I.check /> : <span className="cm-nock" />}
								</button>
							))
						}
					</Menu>
				)}
			</Row>
			<Row label={t.settingsTier} note={t.settingsTierNote}>
				<Menu act="mode" down label={pill(t.tier[s.mode] ?? s.mode, "mode")}>
					{(close) =>
						s.modes.map((m) => (
							<button type="button" key={m.value} className="cm-i" role="menuitemradio" aria-checked={m.value === s.mode} data-tier={m.value} onClick={() => (change({ mode: m.value }), close())}>
								<span className={`cm-dot ${TIER_CLASS[m.value] ?? ""}`} />
								<span className="cm-t">
									<b>{t.tier[m.value] ?? m.label}</b>
									<small>{t.tierNote[m.value] ?? ""}</small>
								</span>
								{m.value === s.mode ? <I.check /> : null}
							</button>
						))
					}
				</Menu>
			</Row>
			<Row label={t.settingsNotify} note={t.settingsNotifyNote}>
				{notify === "blocked" || notify === "unsupported" ? (
					<span className="muted" data-field="notify">
						{notify === "blocked" ? t.notifyBlocked : t.notifyUnsupported}
					</span>
				) : (
					<span data-field="notify" data-state={notify}>
						{notify === "on" ? `${t.notifyOn} · ` : null}
						<button className="chip" onClick={() => (notify === "on" ? setNotify(turnOff()) : void turnOn().then(setNotify))} data-act="notify">
							{notify === "on" ? t.notifyTurnOff : t.notifyTurnOn}
						</button>
					</span>
				)}
			</Row>
			<Row label={t.settingsSignIn}>
				<span className={s.signIn.ok ? "okline" : "warnline"} data-field="signin">
					{s.signIn.text}
				</span>
			</Row>
		</div>
	);
}
