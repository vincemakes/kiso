/**
 * The secret-location deny list (#31; the kiso-secrets spec § 3). True for a
 * path that holds secrets by location: the person's SSH directory, GnuPG,
 * the OS keychain and credential stores, browser profile roots, known
 * password-manager stores, the credential-file set, and kiso's own
 * credentials.
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

/**
 * The directories under home whose whole content is secret, BY NAME ONLY (no
 * fuzzy matching: a path that merely resembles a store is not one). Grouped
 * by class; a new entry is a ruling, judged by its class.
 */
const SECRET_DIRS = [
	// SSH, GnuPG and the OS keychain / credential stores
	".ssh",
	".gnupg",
	"Library/Keychains",
	".local/share/keyrings",
	"AppData/Roaming/Microsoft/Credentials",
	"AppData/Local/Microsoft/Credentials",
	"AppData/Roaming/Microsoft/Protect",
	// browser profile roots (cookies, Login Data, history), macOS / Linux / Windows
	"Library/Application Support/Google/Chrome",
	"Library/Application Support/Chromium",
	"Library/Application Support/Microsoft Edge",
	"Library/Application Support/BraveSoftware/Brave-Browser",
	"Library/Application Support/Firefox/Profiles",
	"Library/Cookies",
	"Library/Safari",
	".config/google-chrome",
	".config/chromium",
	".config/microsoft-edge",
	".config/BraveSoftware/Brave-Browser",
	".mozilla/firefox",
	"AppData/Local/Google/Chrome/User Data",
	"AppData/Local/Chromium/User Data",
	"AppData/Local/Microsoft/Edge/User Data",
	"AppData/Local/BraveSoftware/Brave-Browser/User Data",
	"AppData/Roaming/Mozilla/Firefox/Profiles",
	// password-manager stores
	"Library/Group Containers/2BUA8C4S2C.com.1password",
	"Library/Application Support/1Password",
	".config/1Password",
	"AppData/Local/1Password",
	"Library/Application Support/Bitwarden",
	".config/Bitwarden",
	"AppData/Roaming/Bitwarden",
	".config/keepassxc",
	"AppData/Roaming/KeePassXC",
	".password-store",
	".lpass",
];

/** Password-manager databases, by extension, anywhere. */
const SECRET_EXTENSIONS = [".kdbx"];

export function isSecretLocation(path: string, ctx: SecretLocationContext): boolean {
	const sep = ctx.separator ?? "/";
	const p = fold(path, sep);
	const home = fold(ctx.home, sep);
	const kiso = fold(ctx.kisoHome, sep);
	if (SECRET_DIRS.some((d) => under(p, `${home}/${d.toLowerCase()}`))) return true;
	const base = p.slice(p.lastIndexOf("/") + 1);
	if (isCredentialName(base) || isCredentialPath(p)) return true;
	if (SECRET_EXTENSIONS.some((x) => base.endsWith(x))) return true;
	if (under(p, kiso) && (base === "auth.json" || base.startsWith("credentials"))) return true;
	return false;
}
