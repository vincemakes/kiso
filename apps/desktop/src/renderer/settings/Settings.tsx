import { useEffect, useState, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import type { SettingsPatch, SettingsReply } from "../../shared/settings.js";

async function call(token: string, patch?: SettingsPatch): Promise<SettingsReply> {
	const response = await fetch("/desk/settings", {
		method: patch === undefined ? "GET" : "POST",
		headers: { authorization: `Bearer ${token}` },
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
export function Settings({ token }: { readonly token: string }): ReactNode {
	const [s, setS] = useState<SettingsReply | null>(null);
	useEffect(() => {
		void call(token).then(setS, () => undefined);
	}, [token]);
	const change = (patch: SettingsPatch): void => void call(token, patch).then(setS, () => undefined);
	if (s === null) return <div className="settings" />;
	return (
		<div className="settings" data-kind="settings">
			<h1>{t.settings}</h1>
			<Row label={t.settingsModel} note={t.settingsModelNote}>
				{s.profiles.length === 0 ? (
					<span className="muted">{t.settingsNoModel}</span>
				) : (
					<select value={s.profile ?? ""} onChange={(e) => change({ profile: e.target.value })} data-field="profile">
						{s.profile === null ? <option value="">—</option> : null}
						{s.profiles.map((p) => (
							<option key={p.name} value={p.name}>
								{p.name} · {p.model}
								{p.available ? "" : ` (${t.settingsNotSignedIn})`}
							</option>
						))}
					</select>
				)}
			</Row>
			<Row label={t.settingsEffort} note={t.settingsEffortNote}>
				{s.effort === null ? (
					<span className="muted">{t.settingsEffortUnknown}</span>
				) : (
					<select value={s.effort.current ?? s.effort.default ?? ""} onChange={(e) => change({ effort: e.target.value })} data-field="effort">
						{s.effort.levels.map((level) => (
							<option key={level} value={level}>
								{level}
								{level === s.effort!.default ? ` (${t.settingsDefault})` : ""}
							</option>
						))}
					</select>
				)}
			</Row>
			<Row label={t.settingsTier} note={t.settingsTierNote}>
				<select value={s.mode} onChange={(e) => change({ mode: e.target.value })} data-field="mode">
					{s.modes.map((m) => (
						<option key={m.value} value={m.value}>
							{m.label}
						</option>
					))}
				</select>
			</Row>
			<Row label={t.settingsSignIn}>
				<span className={s.signIn.ok ? "okline" : "warnline"} data-field="signin">
					{s.signIn.text}
				</span>
			</Row>
		</div>
	);
}
