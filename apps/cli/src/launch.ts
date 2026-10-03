/**
 * Windows P3 — how the CLI's small spawns start: `kiso update` (npm), the
 * external editor, and the sign-in page.
 *
 * npm is npm.cmd and an editor is often code.cmd: a .cmd/.bat shim needs
 * cmd.exe to start, and Node will not start one without a shell. Rather
 * than `shell: true`, the call goes to cmd.exe itself — `/d /s /c "<line>"`
 * — with every word quoted by `viaCmd`, the one function here (the
 * cross-spawn rules: CommandLineToArgvW quoting, then a caret before each
 * cmd.exe metacharacter). The shell tool never comes this way: it only
 * ever starts bash (P1).
 *
 * Pure — no process is started here, so importing it moves no test into
 * the pty pool.
 */

/** cmd.exe's metacharacters: each is escaped with a caret. */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument, quoted as CommandLineToArgvW reads it, then escaped for cmd.exe. */
function cmdArgument(arg: string): string {
	const quoted = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
	return quoted.replace(CMD_META, "^$1");
}

export interface Launch {
	readonly file: string;
	readonly args: readonly string[];
	/** Windows: the line is cmd.exe's to parse, not Node's to requote */
	readonly windowsVerbatimArguments?: true;
}

/** `bin args` as cmd.exe starts it. */
export function viaCmd(bin: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): Launch {
	const line = [bin.replace(CMD_META, "^$1"), ...args.map(cmdArgument)].join(" ");
	return { file: env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

/** `bin args` as this platform starts it: directly, or through cmd.exe on Windows. */
export function launchCommand(bin: string, args: readonly string[]): Launch {
	return process.platform === "win32" ? viaCmd(bin, args) : { file: bin, args };
}

/** The platform's URL opener — `rundll32`'s URL handler on Windows (cmd's
 *  `start` would cut a sign-in URL at its first `&`) — or null, and the
 *  URL stays printed. */
export function browserCommand(url: string): readonly [string, readonly string[]] | null {
	if (process.platform === "darwin") return ["open", [url]];
	if (process.platform === "linux") return ["xdg-open", [url]];
	if (process.platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];
	return null;
}
