import type { WireInput } from "@vincemakes/kiso-protocol";

/** What a run accepted and never admitted, as the person's next message: one item as it was, several joined the way the terminal joins them. */
export function unadmittedInput(items: readonly WireInput[]): WireInput | null {
	if (items.length === 0) return null;
	if (items.length === 1) return items[0]!;
	if (items.every((i): i is string => typeof i === "string")) return items.join("\n\n");
	const blocks = items.flatMap((item, i) => [...(i === 0 ? [] : [{ type: "text" as const, text: "\n\n" }]), ...(typeof item === "string" ? [{ type: "text" as const, text: item }] : item)]);
	return blocks;
}
