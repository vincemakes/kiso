/**
 * The secret-location deny list (#31; the kiso-secrets spec § 3). True for a
 * path that holds secrets by location: the person's SSH directory, the
 * credential-file set, the OS keychain stores, and kiso's own credentials.
 * The list is the owner's to confirm (ledger D12); changes are rulings.
 *
 * This answers "is this a secret location" and nothing else: what a read
 * tool does with a hit is its caller's policy. The caller passes a
 * CANONICAL path (symlinks resolved, so a link into ~/.ssh is judged by
 * where it leads) and the host's separator; nothing is imported.
 */
import { isCredentialName, isCredentialPath } from "./credential-files.js";

export interface SecretLocationContext {
	/** The person's home directory, canonical. */
	readonly home: string;
	/** kiso's own home (`~/.kiso` unless overridden), canonical. */
	readonly kisoHome: string;
	/** The host's path separator; "/" when absent. */
	readonly separator?: string;
}

const fold = (path: string, separator: string): string => path.split(separator).join("/").replace(/\/+$/, "").toLowerCase();
const under = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`);

/** The directories under home whose whole content is secret. */
const SECRET_DIRS = [".ssh", ".gnupg", "Library/Keychains", ".local/share/keyrings"];

export function isSecretLocation(path: string, ctx: SecretLocationContext): boolean {
	const sep = ctx.separator ?? "/";
	const p = fold(path, sep);
	const home = fold(ctx.home, sep);
	const kiso = fold(ctx.kisoHome, sep);
	if (SECRET_DIRS.some((d) => under(p, `${home}/${d.toLowerCase()}`))) return true;
	const base = p.slice(p.lastIndexOf("/") + 1);
	if (isCredentialName(base) || isCredentialPath(p)) return true;
	if (under(p, kiso) && (base === "auth.json" || base.startsWith("credentials"))) return true;
	return false;
}
