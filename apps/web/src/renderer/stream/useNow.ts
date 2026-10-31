import { useEffect, useState } from "react";

/** The current time, ticking while `active` — for a clock that counts a live step or run. */
export function useNow(active: boolean, everyMs = 250): number {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), everyMs);
		return () => clearInterval(id);
	}, [active, everyMs]);
	return now;
}
