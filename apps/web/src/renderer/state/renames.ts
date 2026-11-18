import { useEffect, useState } from "react";
import type { WorkRow } from "../../shared/history.js";

type Names = Readonly<Record<string, string>>;
const without = (n: Names, id: string): Names => Object.fromEntries(Object.entries(n).filter(([k]) => k !== id));

/**
 * The names a person has just typed, shown at once and kept over any listing that still has the old one (the listing is read at most
 * every 3 s while a Work runs). A name gives way when a listing shows it (the host has it) or the host answers; a refused rename puts
 * the old name back and passes the refusal on. An empty name (clear it) shows nothing early: the listing says what it falls back to.
 */
export function useRenames(works: readonly WorkRow[]): readonly [Names, (id: string, name: string, send: () => Promise<{ readonly name: string | null }>) => Promise<void>] {
	const [named, setNamed] = useState<Names>({});
	useEffect(() => {
		const done = Object.keys(named).filter((id) => works.find((w) => w.id === id)?.title === named[id]);
		if (done.length > 0) setNamed((n) => done.reduce(without, n));
	}, [works, named]);
	const rename = (id: string, name: string, send: () => Promise<{ readonly name: string | null }>): Promise<void> => {
		const was = named[id];
		if (name.trim() !== "") setNamed((n) => ({ ...n, [id]: name.trim() }));
		return send().then((r) => setNamed((n) => (r.name === null ? without(n, id) : { ...n, [id]: r.name })), (e: unknown) => (setNamed((n) => (was === undefined ? without(n, id) : { ...n, [id]: was })), Promise.reject(e)));
	};
	return [named, rename];
}
