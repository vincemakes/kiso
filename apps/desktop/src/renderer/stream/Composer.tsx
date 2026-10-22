import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { t } from "../i18n/index.js";
import { ArrowUp } from "./Icons.js";

interface Props {
	readonly running: boolean;
	readonly onSend: (text: string) => void;
	readonly onSteer: (text: string) => void;
	readonly onStop: () => void;
}

/**
 * The input. Idle: Enter sends. While a run is live the same box adds a line
 * to it (a steer), and Esc or the button stops it. Shift+Enter is a newline;
 * Enter during IME composition is not a send.
 */
export function Composer({ running, onSend, onSteer, onStop }: Props): ReactNode {
	const [text, setText] = useState("");
	const box = useRef<HTMLTextAreaElement>(null);
	const submit = (): void => {
		const line = text.trim();
		if (line === "") return;
		(running ? onSteer : onSend)(line);
		setText("");
		if (box.current !== null) box.current.style.height = "auto";
	};
	const key = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		} else if (e.key === "Escape" && running) onStop();
	};
	const grow = (el: HTMLTextAreaElement): void => {
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};
	return (
		<div className="comp" data-kind="composer">
			<div className="box">
				<textarea
					ref={box}
					rows={1}
					value={text}
					placeholder={running ? t.inputRunning : t.inputPlaceholder}
					onChange={(e) => {
						setText(e.target.value);
						grow(e.target);
					}}
					onKeyDown={key}
				/>
				{running && text.trim() === "" ? (
					<button className="sendb run" aria-label={t.stop} onClick={onStop} data-act="stop">
						<i />
					</button>
				) : (
					<button className={`sendb${text.trim() === "" ? "" : " ready"}`} aria-label={t.send} onClick={submit} data-act="send">
						<ArrowUp />
					</button>
				)}
			</div>
		</div>
	);
}
