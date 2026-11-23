import { useEffect, useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import { checkUpdateNow, fetchUpdate, switchUpdateCheck } from "../state/update.js";
import type { UpdateReply } from "../../shared/update.js";

/** The Settings rows for the check for a newer kiso web: the version row (running, latest known, Check now) and the switch. */
export function UpdateRows(): ReactNode {
	const [u, setU] = useState<UpdateReply | null>(null);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		void fetchUpdate().then(setU, () => undefined);
	}, []);
	if (u === null) return null;
	const row = (label: string, note: string, field: ReactNode): ReactNode => (
		<div className="srow">
			<div className="slabel">
				{label}
				<small>{note}</small>
			</div>
			<div className="sfield">{field}</div>
		</div>
	);
	return (
		<>
			{row(
				t.settingsVersion,
				t.settingsVersionNote,
				<span data-field="version">
					{fmt(t.updateRunning, { current: u.current })} · {u.latest === null ? t.updateUnknown : fmt(t.updateLatest, { latest: u.latest })}
					{u.enabled ? (
						<>
							<button className="chip" data-act="update-check" disabled={busy} onClick={() => (setBusy(true), void checkUpdateNow().then(setU, () => undefined).finally(() => setBusy(false)))}>
								{busy ? t.updateChecking : t.updateCheckNow}
							</button>
						</>
					) : null}
				</span>,
			)}
			{row(
				t.settingsUpdates,
				t.settingsUpdatesNote,
				u.locked ? (
					<span className="muted" data-field="updates">{t.updateOffByEnv}</span>
				) : (
					<button className="chip" data-act="update-switch" data-state={u.enabled ? "on" : "off"} onClick={() => void switchUpdateCheck(!u.enabled).then(setU, () => undefined)}>
						{u.enabled ? t.updateOn : t.updateOff}
					</button>
				),
			)}
		</>
	);
}
