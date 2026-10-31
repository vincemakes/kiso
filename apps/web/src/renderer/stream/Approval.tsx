import { useState, type ReactNode } from "react";
import { fmt, t } from "../i18n/index.js";
import { editDiff } from "../state/diff.js";
import type { Ask } from "../state/model.js";
import { Warn } from "./Icons.js";

/** The card's title and the detail under it, by what is being asked. */
export function describe(ask: Ask): { title: string; detail: { text: string; mark: "" | "a" | "d" }[] } {
	const i = ask.input;
	const str = (k: string): string => (typeof i[k] === "string" ? (i[k] as string) : "");
	if (ask.name === "shell") return { title: t.askRun, detail: [{ text: str("command"), mark: "" }] };
	if (ask.name === "edit_file") {
		const diff = editDiff(i).map((l) => ({ text: `${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${l.text}`, mark: (l.kind === "add" ? "a" : l.kind === "del" ? "d" : "") as "" | "a" | "d" }));
		return { title: fmt(t.askEdit, { path: str("path") }), detail: diff };
	}
	if (ask.name === "write_file") return { title: fmt(t.askWrite, { path: str("path") }), detail: str("content").split("\n").slice(0, 12).map((text) => ({ text: `+ ${text}`, mark: "a" as const })) };
	return { title: fmt(t.askOther, { name: ask.name }), detail: [{ text: JSON.stringify(i), mark: "" }] };
}

/** What the approval was about, in a few words: the file, or the command's first line. */
function summary(ask: Ask): string {
	const i = ask.input;
	const v = ask.name === "shell" ? i["command"] : i["path"];
	return typeof v === "string" ? v.split("\n")[0]! : "";
}

/** An approval, as its own card. It is never folded into the process while open. */
export function Approval({ ask, onAnswer }: { readonly ask: Ask; readonly onAnswer: (decisionId: string, allow: boolean) => void }): ReactNode {
	const [sent, setSent] = useState(false);
	if (ask.decision !== "open") {
		return (
			<div className="note" data-kind="ask-decided">
				<span className={ask.decision === "approved" ? "ok" : "no"} />
				{ask.decision === "approved" ? t.approved : t.denied} · {t.verb[ask.name] ?? ask.name} {summary(ask)}
			</div>
		);
	}
	const { title, detail } = describe(ask);
	const answer = (allow: boolean): void => {
		setSent(true);
		onAnswer(ask.decisionId, allow);
	};
	return (
		<div className="ask" data-kind="ask" data-decision={ask.decisionId}>
			<div className="h">
				<Warn />
				{title}
			</div>
			<pre>
				{detail.map((l, i) => (
					<div key={i} className={l.mark}>
						{l.text || " "}
					</div>
				))}
			</pre>
			<button className="btn pri" disabled={sent} onClick={() => answer(true)} data-act="allow">
				{t.allow}
			</button>
			<button className="btn" disabled={sent} onClick={() => answer(false)} data-act="deny">
				{t.deny}
			</button>
		</div>
	);
}
