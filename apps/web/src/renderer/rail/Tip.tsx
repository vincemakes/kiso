import type { ReactNode } from "react";

/** What a hover shows: a heading, rows of label and value, a log or lines, and an optional enlarged preview. */
export interface TipData {
	readonly head?: string;
	readonly rows?: readonly (readonly [string, string])[];
	readonly log?: readonly string[];
	readonly note?: string;
	readonly big?: ReactNode;
}

/** The hover card, drawn to the left of the rail beside the row that asked for it (hung from the row's bottom edge when the row is low in the window). */
export function Tip({ tip, top, bottom }: { readonly tip: TipData | null; readonly top?: number; readonly bottom?: number }): ReactNode {
	if (tip === null) return null;
	return (
		<div className="tip show" style={bottom === undefined ? { top } : { bottom }} data-kind="tip">
			{tip.big !== undefined ? <div className="big">{tip.big}</div> : null}
			{tip.head !== undefined ? <h6>{tip.head}</h6> : null}
			{tip.rows?.map(([k, v]) => (
				<div className="kv" key={k}>
					<span>{k}</span>
					<b>{v}</b>
				</div>
			))}
			{tip.log !== undefined && tip.log.length > 0 ? <div className="lg">{tip.log.join("\n")}</div> : null}
			{tip.note !== undefined ? <div className="tnote">{tip.note}</div> : null}
		</div>
	);
}
