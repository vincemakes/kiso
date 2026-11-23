import { useCallback, useEffect, useRef, useState } from "react";
import type { GitReply, PrRow } from "../../shared/git.js";
import { fetchPrs } from "./desk.js";

/**
 * The rail's pull request rows for a Work: read again whenever the git reply is (a run ended, a commit, a pull request created), twice
 * shortly after one is first seen (`gh` answers a moment later), and every 20 s while an open one has checks still running.
 */
export function usePrRows(key: string | null, session: string, git: GitReply | null): readonly PrRow[] {
	const [prs, setPrs] = useState<readonly PrRow[]>([]);
	const tries = useRef(0);
	const read = useCallback(() => void fetchPrs(key, session).then((r) => setPrs(r.prs), () => setPrs([])), [key, session]);
	useEffect(() => {
		tries.current = 0;
		read();
	}, [read, git]);
	const unknown = prs.some((p) => p.state === undefined);
	const running = prs.some((p) => p.state === "OPEN" && p.checks !== undefined && p.checks.done < p.checks.total);
	useEffect(() => {
		if (!running && !(unknown && tries.current < 2)) return;
		const timer = setTimeout(() => ((tries.current += running ? 0 : 1), read()), running ? 20_000 : 3_000);
		return () => clearTimeout(timer);
	}, [prs, running, unknown, read]);
	return prs;
}
