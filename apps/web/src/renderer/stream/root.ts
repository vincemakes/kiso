import { createContext, useContext } from "react";

/** The Work's folder (its real path): a path inside it is shown relative to it in the stream. */
export const RootContext = createContext("");

/** `text` with every path inside `root` written relative to it (macOS names its temporary folders with and without /private); the root itself is left as it is. */
export function relativeTo(text: string, root: string): string {
	if (root === "" || root === "/") return text;
	const roots = [root, root.startsWith("/private/") ? root.slice(8) : `/private${root}`];
	let out = text;
	for (const r of roots) out = out.split(`${r}/`).join("");
	return out;
}

export const useRelative = (): ((text: string) => string) => {
	const root = useContext(RootContext);
	return (text) => relativeTo(text, root);
};
