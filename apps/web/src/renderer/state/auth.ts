/**
 * The page's sign-in: the one-time code the command put in the address is traded for the host's session cookie (HttpOnly: the page
 * cannot read it, and holds no secret of its own). Asked once per page load, however often a component asks.
 */

let asked: Promise<boolean> | undefined;

export function signIn(code: string | null): Promise<boolean> {
	asked ??= (async () => {
		if (code !== null && code !== "") await fetch("/auth/connect", { method: "POST", body: JSON.stringify({ code }) }).catch(() => undefined);
		const status = await fetch("/auth/status").then((r) => r.json() as Promise<{ signedIn?: boolean }>, () => ({ signedIn: false }));
		return status.signedIn === true;
	})();
	return asked;
}
