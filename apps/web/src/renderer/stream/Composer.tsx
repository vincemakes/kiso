import { useContext, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react";
import type { WireContentBlock, WireInput } from "@vincemakes/kiso-protocol";
import { fmt, t } from "../i18n/index.js";
import { ArrowUp, I, Plus } from "./Icons.js";
import { LinkLine, type Down } from "./LinkLine.js";
import { AtPicker, atHits, ControlsContext, Menu, ModelMenu, TierMenu } from "./ComposerMenus.js";

interface Props {
	readonly running: boolean;
	/** the line the person may send next: the empty box's placeholder, Tab takes it */
	readonly suggestion?: string | null;
	readonly onSend: (input: WireInput) => void;
	readonly onSteer: (input: WireInput) => void;
	readonly onStop: () => void;
	/** the connection is down: the line says so, and Send waits (typing does not) */
	readonly down?: Down | null;
	/** the home screen draws the box in the middle, with the tray under it */
	readonly inline?: boolean;
	readonly children?: ReactNode;
}

/** A thing added to the line: a picture (sent as an image block) or a text file (sent as its text, named). */
type Attachment = { readonly kind: "image"; readonly name: string; readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; readonly data: string } | { readonly kind: "file"; readonly name: string; readonly text: string };

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_CAP = 5 * 1024 * 1024;
const TEXT_CAP = 256 * 1024;

/** Read a dropped, pasted or chosen file: a picture as base64, a text file as UTF-8 text; anything else is refused in words. */
async function attach(file: File): Promise<Attachment | string> {
	if (IMAGE_TYPES.has(file.type)) {
		if (file.size > IMAGE_CAP) return fmt(t.attachTooBig, { name: file.name, cap: "5 MB" });
		const bytes = new Uint8Array(await file.arrayBuffer());
		let bin = "";
		for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
		return { kind: "image", name: file.name || "pasted.png", mediaType: file.type as Extract<Attachment, { kind: "image" }>["mediaType"], data: btoa(bin) };
	}
	if (file.size > TEXT_CAP) return fmt(t.attachTooBig, { name: file.name, cap: "256 KB" });
	const text = await file.text();
	// a NUL, or the decoder's replacement character, says the bytes are not UTF-8 text
	if (text.includes("\u0000") || text.includes("�")) return fmt(t.attachNotText, { name: file.name });
	return { kind: "file", name: file.name, text };
}

/** The line as the wire takes it: plain text when nothing is attached, else its blocks (the words, the pictures, each file's text). */
function lineOf(text: string, attached: readonly Attachment[]): WireInput {
	if (attached.length === 0) return text;
	const blocks: WireContentBlock[] = text === "" ? [] : [{ type: "text", text }];
	for (const a of attached) blocks.push(a.kind === "image" ? { type: "image", sourceType: "base64", data: a.data, mediaType: a.mediaType } : { type: "text", text: `${a.name}:\n\`\`\`\n${a.text}\n\`\`\`` });
	return blocks;
}

/**
 * The input. Idle: Enter sends. While a run is live the same box adds a line to it (a steer), and Esc or the button stops it.
 * Shift+Enter is a newline; Enter during IME composition is not a send. Pictures and text files come in by paste, by drop, or
 * by `+`; `@` names a file of the folder. The bar under the box holds `+`, this Work's tier, and its model and effort. A picture
 * waits in the box, unsent, while the model in use is not known to read images.
 */
export function Composer({ running, suggestion = null, onSend, onSteer, onStop, inline = false, down = null, children }: Props): ReactNode {
	const c = useContext(ControlsContext);
	const [text, setText] = useState("");
	const [attached, setAttached] = useState<readonly Attachment[]>([]);
	const [note, setNote] = useState<string | null>(null);
	const [drag, setDrag] = useState(false);
	const [at, setAt] = useState<{ readonly query: string; readonly from: number; readonly active: number } | null>(null);
	const [files, setFiles] = useState<readonly string[] | null>(null);
	const box = useRef<HTMLTextAreaElement>(null);
	const pick = useRef<HTMLInputElement>(null);
	const profile = c?.settings?.profiles.find((p) => p.name === c.settings?.profile) ?? null;
	const blocked = attached.some((a) => a.kind === "image") && profile !== null && !profile.images;
	const ready = (text.trim() !== "" || attached.length > 0) && !blocked;
	const add = async (list: readonly File[]): Promise<void> => {
		const got = await Promise.all(list.map(attach));
		setAttached((was) => [...was, ...got.filter((g): g is Attachment => typeof g !== "string")]);
		const refused = got.filter((g): g is string => typeof g === "string");
		setNote(refused.length === 0 ? null : refused.join(" "));
	};
	const grow = (el: HTMLTextAreaElement): void => {
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	};
	const submit = (): void => {
		if (!ready || down !== null) return;
		(running ? onSteer : onSend)(lineOf(text.trim(), attached));
		setText("");
		setAttached([]);
		setNote(null);
		if (box.current !== null) box.current.style.height = "auto";
	};
	// `@` right before the caret (at the start or after a space) opens the picker on what follows it
	const watchAt = (el: HTMLTextAreaElement): void => {
		const m = /(^|\s)@([^\s@]*)$/.exec(el.value.slice(0, el.selectionStart));
		if (m === null || c === null) return setAt(null);
		setAt({ query: m[2] ?? "", from: el.selectionStart - (m[2] ?? "").length - 1, active: 0 });
		if (files === null) void c.atFiles().then(setFiles, () => setFiles([]));
	};
	const choose = (path: string): void => {
		if (at === null || box.current === null) return;
		const el = box.current;
		const next = `${text.slice(0, at.from)}@${path} ${text.slice(el.selectionStart)}`;
		setText(next);
		setAt(null);
		requestAnimationFrame(() => (el.focus(), (el.selectionStart = el.selectionEnd = at.from + path.length + 2)));
	};
	const key = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
		if (at !== null && files !== null) {
			const hits = atHits(files, at.query);
			if (e.key === "ArrowDown" || e.key === "ArrowUp") return (e.preventDefault(), setAt({ ...at, active: (at.active + (e.key === "ArrowDown" ? 1 : hits.length - 1)) % Math.max(1, hits.length) }));
			if ((e.key === "Enter" || e.key === "Tab") && hits[at.active] !== undefined) return (e.preventDefault(), choose(hits[at.active]!));
			if (e.key === "Escape") return (e.preventDefault(), setAt(null));
		}
		if (e.key === "Tab" && !e.shiftKey && !running && suggestion != null && text === "") return (e.preventDefault(), setText(suggestion));
		if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
			e.preventDefault();
			submit();
		} else if (e.key === "Escape" && running) onStop();
	};
	const paste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
		const list = Array.from(e.clipboardData.files);
		if (list.length === 0) return; // text pastes as text, the browser's own way
		e.preventDefault();
		void add(list);
	};
	const over = (e: DragEvent): void => {
		if (![...e.dataTransfer.types].includes("Files")) return;
		e.preventDefault();
		setDrag(true);
	};
	const drop = (e: DragEvent): void => {
		e.preventDefault();
		setDrag(false);
		void add(Array.from(e.dataTransfer.files));
	};
	return (
		<div className={`comp${inline ? " inline" : ""}`} data-kind="composer">
			{down !== null ? <LinkLine down={down} /> : null}
			<div className={`box${drag ? " drag" : ""}`} onDragOver={over} onDragLeave={() => setDrag(false)} onDrop={drop} data-drag={drag ? "1" : "0"}>
				{blocked ? (
					<div className="cwarn" data-kind="images-held">
						<I.image />
						<span>{fmt(t.imagesHeld, { model: profile?.model ?? "" })}</span>
					</div>
				) : null}
				{attached.length > 0 ? (
					<div className="atts" data-kind="attachments">
						{attached.map((a, i) => (
							<span key={`${a.name}-${i}`} className={`att ${a.kind}`} data-attachment={a.kind} title={a.name}>
								{a.kind === "image" ? <img src={`data:${a.mediaType};base64,${a.data}`} alt="" /> : <><I.file /><span>{a.name}</span></>}
								<button type="button" className="att-x" aria-label={fmt(t.attachRemove, { name: a.name })} onClick={() => setAttached(attached.filter((_, j) => j !== i))}>
									<I.close />
								</button>
							</span>
						))}
					</div>
				) : null}
				<textarea
					ref={box}
					rows={1}
					value={text}
					placeholder={running ? t.inputRunning : (suggestion ?? t.inputPlaceholder)}
					data-suggestion={suggestion ?? undefined}
					onChange={(e) => {
						setText(e.target.value);
						grow(e.target);
						watchAt(e.target);
					}}
					onKeyDown={key}
					onPaste={paste}
					onBlur={() => setAt(null)}
				/>
				{at !== null && files !== null ? <AtPicker query={at.query} files={files} active={at.active} onPick={choose} /> : null}
				{note !== null ? <div className="cnote" data-kind="attach-note">{note}</div> : null}
				<div className="cbar">
					<input ref={pick} type="file" multiple hidden onChange={(e) => (void add(Array.from(e.target.files ?? [])), (e.target.value = ""))} />
					<Menu act="add" className="round" label={<Plus />} title={t.addTitle}>
						{(close) => (
							<>
								<button type="button" className="cm-i" data-add="image" onClick={() => (pick.current?.setAttribute("accept", "image/png,image/jpeg,image/webp,image/gif"), pick.current?.click(), close())}>
									<I.image />
									<span className="cm-t">
										<b>{t.addImages}</b>
										<small>{t.addImagesNote}</small>
									</span>
								</button>
								<button type="button" className="cm-i" data-add="file" onClick={() => (pick.current?.removeAttribute("accept"), pick.current?.click(), close())}>
									<I.file />
									<span className="cm-t">
										<b>{t.addFiles}</b>
										<small>{t.addFilesNote}</small>
									</span>
								</button>
								<button type="button" className="cm-i" data-add="at" onClick={() => (close(), setText(`${text}${text === "" || text.endsWith(" ") ? "" : " "}@`), requestAnimationFrame(() => box.current !== null && (box.current.focus(), watchAt(box.current))))}>
									<span className="cm-at">@</span>
									<span className="cm-t">
										<b>{t.addAt}</b>
										<small>{t.addAtNote}</small>
									</span>
								</button>
							</>
						)}
					</Menu>
					{c !== null ? <TierMenu c={c} /> : null}
					<span className="grow" />
					{c !== null && (c.settings?.profiles.length ?? 0) > 0 ? <ModelMenu c={c} running={running} /> : null}
					{running && !ready ? (
						<button className="sendb run" aria-label={t.stop} onClick={onStop} data-act="stop">
							<i />
						</button>
					) : (
						<button className={`sendb${ready ? " ready" : ""}`} aria-label={t.send} onClick={submit} data-act="send" disabled={blocked || down !== null} title={down?.text}>
							<ArrowUp />
						</button>
					)}
				</div>
			</div>
			{children}
		</div>
	);
}
