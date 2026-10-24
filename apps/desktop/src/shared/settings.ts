/** What `GET /desk/settings` answers and `POST /desk/settings` takes. No credential is ever in it: only where the sign-in comes from. */

export interface ProfileRow {
	readonly name: string;
	/** the model id the profile names */
	readonly model: string;
	readonly available: boolean;
}

export interface SettingsReply {
	/** the profiles of the shared configuration (`~/.kiso/config.json`) */
	readonly profiles: readonly ProfileRow[];
	/** the profile new Works run on, or null when none resolves */
	readonly profile: string | null;
	/** the levels the profile's route accepts, the one it uses when none is sent, and the one new Works start at */
	readonly effort: { readonly levels: readonly string[]; readonly default: string | null; readonly current: string | null } | null;
	/** the permission tier, and the tiers on offer; process-wide */
	readonly mode: string;
	readonly modes: readonly { readonly value: string; readonly label: string }[];
	/** the sign-in of the chosen profile, in words that name where it comes from and never carry a secret */
	readonly signIn: { readonly ok: boolean; readonly text: string };
}

export interface SettingsPatch {
	readonly profile?: string;
	readonly effort?: string;
	readonly mode?: string;
}
