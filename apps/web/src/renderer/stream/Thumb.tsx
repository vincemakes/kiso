import type { ReactNode } from "react";
import { useOpenPanel } from "../panels/context.js";

/** A thumbnail of what a step produced: a diff or a terminal. */
export const Thumb = ({ kind }: { kind: "diff" | "term" }): ReactNode => (
	<span className={`mt ${kind}`}>
		<i />
		<i />
		<i />
		<i />
	</span>
);

/** A thumbnail that opens the panel it stands for (a diff: Changes; a terminal: Terminal and tasks). A span, because it also sits inside buttons. */
export function ThumbLink({ kind }: { readonly kind: "diff" | "term" }): ReactNode {
	const open = useOpenPanel();
	return (
		<span
			role="button"
			tabIndex={0}
			className="thl"
			data-thumb={kind}
			onClick={(e) => {
				e.stopPropagation();
				open(kind === "diff" ? "diff" : "term");
			}}
		>
			<Thumb kind={kind} />
		</span>
	);
}

export const thumbOf = (name: string): "diff" | "term" | null => (name === "edit_file" || name === "write_file" ? "diff" : name === "shell" ? "term" : null);
