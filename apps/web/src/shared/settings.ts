/** What `GET /desk/settings` answers and `POST /desk/settings` takes. No credential is ever in it: only where the sign-in comes from. */

export interface ProfileRow {
	readonly name: string;
	/** the model id the profile names */
	readonly model: string;
	readonly available: boolean;
	/** the model table says this model reads images (unknown is false: an image is not sent to a model that might drop it) */
	readonly images: boolean;
}

export interface SettingsReply {
	/** the profiles of the shared configuration (`~/.kiso/config.json`) */
	readonly profiles: readonly ProfileRow[];
	/** the profile new Works run on, or null when none resolves */
	readonly profile: string | null;
	/** the levels the profile's route accepts, the one it uses when none is sent, and the one new Works start at */
	readonly effort: { readonly levels: readonly string[]; readonly default: string | null; readonly current: string | null } | null;
	/** the permission tier: this Work's when a Work is asked about, else the one new Works start with; and the tiers on offer */
	readonly mode: string;
	/** ready: a profile can run; signin: profiles exist but the chosen one has no sign-in; noprofile: none configured; demo: the scripted tour is on */
	readonly setup: "ready" | "signin" | "noprofile" | "demo";
	readonly modes: readonly { readonly value: string; readonly label: string }[];
	/** the sign-in of the chosen profile, in words that name where it comes from and never carry a secret */
	readonly signIn: { readonly ok: boolean; readonly text: string };
}

/** What `GET /desk/env?key=` answers: where a Work runs. `mode` is the permission tier's value. */
export interface EnvReply {
	readonly folder: string;
	readonly path: string;
	/** the folder's full real path: the stream shows paths inside it relative to it */
	readonly root: string;
	readonly branch: string | null;
	readonly mode: string;
}

export interface SettingsPatch {
	/** with `session`, that Work's profile (the host rebuilds it before its next run); without, the profile new Works run on */
	readonly profile?: string;
	/** with `session`, that Work's effort; without, the effort the profile starts at */
	readonly effort?: string;
	/** with `session`, that Work's tier; without, the tier new Works start with */
	readonly mode?: string;
	readonly session?: string;
}

/** What `GET /desk/context?session=` answers: what a Work's requests always carry, in bytes (the page estimates tokens from them and
 *  says so), and the context sizes at which compaction becomes eligible and must happen (the runtime's tiers; null without a stated window). */
export interface ContextParts {
	readonly system: number;
	readonly instructions: number;
	readonly tools: { readonly count: number; readonly bytes: number };
	readonly compaction: { readonly starts: number; readonly must: number } | null;
}
