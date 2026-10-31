import { useState, type ReactNode } from "react";
import type { SettingsReply } from "../../shared/settings.js";
import { fmt, t } from "../i18n/index.js";
import { saveKey, startDemo } from "../state/desk.js";

interface Props {
	readonly settings: SettingsReply;
	/** the host's state changed (a key was stored, the tour started): read it again */
	readonly onChanged: () => void;
}

/**
 * The first-run guide, on the home screen while no profile can run: pick a profile, give its key, or watch the scripted tour. The key
 * goes to the host once and the field is emptied at the same moment: it is never kept in the page's state, never echoed, and what comes back
 * is only whether it was kept.
 */
export function Guide({ settings, onChanged }: Props): ReactNode {
	const [picked, setPicked] = useState<string | null>(null);
	const [field, setField] = useState("");
	const [refused, setRefused] = useState(false);
	const submit = (): void => {
		const profile = picked;
		const key = field;
		setField("");
		if (profile === null || key === "") return;
		void saveKey(profile, key).then(
			() => {
				setPicked(null);
				setRefused(false);
				onChanged();
			},
			() => setRefused(true),
		);
	};
	return (
		<div className="guide" data-kind="guide" data-setup={settings.setup}>
			<h2>{t.guideTitle}</h2>
			<p>{settings.setup === "noprofile" ? t.guideNoProfile : t.guideSignIn}</p>
			{settings.setup === "signin" && picked === null
				? settings.profiles.map((p) => (
						<button key={p.name} className="gprofile" onClick={() => setPicked(p.name)} data-profile={p.name}>
							<b>{p.name}</b> <span>{p.model}</span>
							<small>{p.available ? "" : t.guideNotSignedIn}</small>
						</button>
					))
				: null}
			{picked !== null ? (
				<form
					onSubmit={(e) => {
						e.preventDefault();
						submit();
					}}
				>
					<label>{fmt(t.guideKeyFor, { name: picked })}</label>
					<input type="password" value={field} onChange={(e) => setField(e.target.value)} autoComplete="off" spellCheck={false} data-field="key" />
					{refused ? <div className="pnote warn">{t.guideRefused}</div> : null}
					<div className="grow-row">
						<button type="submit" className="btn pri" data-act="save-key">
							{t.guideSave}
						</button>
						<button type="button" className="btn" onClick={() => setPicked(null)}>
							{t.guideBack}
						</button>
					</div>
				</form>
			) : null}
			<button
				className="gdemo"
				onClick={() => void startDemo().then(onChanged)}
				data-act="demo"
			>
				{t.guideDemo}
			</button>
		</div>
	);
}
