/** A thing added to the line: a picture (sent as an image block) or a text file (sent as its text, named). */
export type Attachment = { readonly kind: "image"; readonly name: string; readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; readonly data: string } | { readonly kind: "file"; readonly name: string; readonly text: string };

/** What the page keeps of how a Work was left, beside its state: where the person was reading (a block of a turn, and its offset from the
 *  top of the view; null: at the end, following) and the line they had not sent. A Work shown again gets both back. */
export interface View {
	pos: { readonly turn: string; readonly n: number; readonly top: number } | null;
	draft: { readonly text: string; readonly attached: readonly Attachment[] } | null;
}
