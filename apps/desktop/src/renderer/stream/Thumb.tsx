import type { ReactNode } from "react";

/** A thumbnail of what a step produced: a diff or a terminal. */
export const Thumb = ({ kind }: { kind: "diff" | "term" }): ReactNode => (
	<span className={`mt ${kind}`}>
		<i />
		<i />
		<i />
		<i />
	</span>
);

export const thumbOf = (name: string): "diff" | "term" | null => (name === "edit_file" || name === "write_file" ? "diff" : name === "shell" ? "term" : null);
