import { createContext, useContext } from "react";

/** The Work's folder (its real path): a path inside it is shown relative to it in the stream. */
export const RootContext = createContext("");

/** For display only: `text` with every path inside `root` written relative to it, and the root itself as the folder's name (macOS names its temporary folders with and without /private). */
export function relativeTo(text: string, root: string): string {
	if (root === "" || root === "/") return text;
	const roots = [root, root.startsWith("/private/") ? root.slice(8) : `/private${root}`];
	let out = text;
	const name = root.split("/").pop() ?? root;
	for (const r of roots) out = out.split(`${r}/`).join("").split(r).join(name);
	return out;
}

export const useRelative = (): ((text: string) => string) => {
	const root = useContext(RootContext);
	return (text) => relativeTo(text, root);
};
