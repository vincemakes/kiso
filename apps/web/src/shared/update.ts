/** What `GET /desk/update` answers: what kiso web knows about a newer release of itself. Nothing here is ever a secret. */
export interface UpdateReply {
	/** the version of this host */
	readonly current: string;
	/** the newest release the registry reported (the last answer it gave), or null when it never answered */
	readonly latest: string | null;
	/** `latest` is newer than `current` */
	readonly newer: boolean;
	/** the person closed the pill for `latest` */
	readonly hidden: boolean;
	/** the check is on: neither KISO_NO_UPDATE_CHECK=1 nor the Settings switch has turned it off */
	readonly enabled: boolean;
	/** it is off because of the environment variable, so the Settings switch cannot turn it on */
	readonly locked: boolean;
	/** when the registry last answered, epoch ms, or null */
	readonly checkedAt: number | null;
}
