#!/usr/bin/env node
/**
 * nested-lanes-model.mjs — AF-1b, free: an explicit-state model of how nested (parent/child) calls are scheduled.
 * Not the kernel: an abstract machine with the kernel's top-level rule (FIFO fence; a shared call waits for earlier exclusive
 * calls, an exclusive call waits for every earlier call) and four ways to place children. Every interleaving of every small
 * configuration (1-3 top-level calls, each exclusive or shared, with 0-2 children each exclusive or shared) is explored.
 *
 *   A  naive      children join the turn's FIFO behind everything accepted (+ a parent is not done before its children)
 *   B  B1         one lane per parent; a parent may end before its children (the state at the owner's first review)
 *   C  B1+AF-5    ... and a parent ends only after its children
 *   D  B1+AF-5+AF-1a  ... and a shared parent's exclusive child is refused
 *   E  full nested exclusion: an exclusive child waits until nothing but its own ancestors/descendants runs, and blocks every unrelated start (+ AF-5)
 * Children are invoked in order while the parent runs; a child never invoked is not a wait. Checked: DEADLOCK (not finished, nothing can
 * move) and ISOLATION (an exclusive entity runs only beside its own ancestors and descendants).
 */
const variants = ["A", "B", "C", "D", "E"];
const kinds = ["E", "S"];
const childSets = [[], ["E"], ["S"], ["E", "E"], ["E", "S"], ["S", "E"], ["S", "S"]];
const tops = kinds.flatMap((k) => childSets.map((c) => ({ k, kids: c })));

function explore(config, variant) {
	// entity ids: tops 0..n-1, then children. status: 0 idle (a top not started / a child not invoked), 1 queued (a child invoked, not started),
	// 2 running, 3 done. A child the parent never invokes simply stays idle: that is not a wait.
	const ents = config.map((t, i) => ({ id: i, k: t.k, top: true, parent: -1, order: i }));
	let order = config.length;
	config.forEach((t, i) => t.kids.forEach((k) => ents.push({ id: ents.length, k, top: false, parent: i, order: order++ })));
	const N = ents.length;
	const unrelatedRunning = (s, e) => ents.some((y) => y.id !== e.id && s[y.id] === 2 && !related(e, y));
	const unrelatedExclusiveRunning = (s, e) => ents.some((y) => y.id !== e.id && y.k === "E" && s[y.id] === 2 && !related(e, y));
	const refusedKid = (e) => variant === "D" && !e.top && config[e.parent].k === "S" && e.k === "E";
	const done = (s, id) => s[id] === 3;
	const kidsOf = (id) => ents.filter((x) => !x.top && x.parent === id);
	const enabled = (s) => {
		const moves = [];
		for (const e of ents) {
			if (e.top) {
				if (s[e.id] === 0) {
					const earlier = ents.filter((x) => x.top && x.id < e.id);
					const ok = e.k === "S" ? earlier.filter((x) => x.k === "E").every((x) => done(s, x.id)) : earlier.every((x) => done(s, x.id));
					if (ok && !(variant === "E" && unrelatedExclusiveRunning(s, e))) moves.push(["start", e.id]);
				} else if (s[e.id] === 2) {
					// B: a parent may end with children still queued or running (orphans); the others: only when none is queued or running
					if (variant === "B" || kidsOf(e.id).every((x) => s[x.id] === 0 || s[x.id] === 3)) moves.push(["finish", e.id]);
				}
			} else {
				if (s[e.id] === 0 && s[e.parent] === 2) {
					// children are invoked in order, one after another, only while the parent runs
					if (kidsOf(e.parent).filter((x) => x.order < e.order).every((x) => s[x.id] !== 0)) moves.push(["invoke", e.id]);
				} else if (s[e.id] === 1) {
					if (refusedKid(e)) { moves.push(["refuse", e.id]); continue; }
					let ok;
					if (variant === "A") {
						// behind everything accepted before it: every top-level call and the children invoked before it
						const before = ents.filter((x) => x.id !== e.id && (x.top || x.order < e.order));
						ok = e.k === "S" ? before.filter((x) => x.k === "E").every((x) => done(s, x.id)) : before.every((x) => done(s, x.id));
					} else if (variant === "E") {
						const sibs = kidsOf(e.parent).filter((x) => x.order < e.order && s[x.id] !== 0);
						const lane = e.k === "S" ? sibs.filter((x) => x.k === "E").every((x) => done(s, x.id)) : sibs.every((x) => done(s, x.id));
						ok = lane && (e.k === "E" ? !unrelatedRunning(s, e) : !unrelatedExclusiveRunning(s, e));
					} else {
						const sibs = kidsOf(e.parent).filter((x) => x.order < e.order && s[x.id] !== 0);
						ok = e.k === "S" ? sibs.filter((x) => x.k === "E").every((x) => done(s, x.id)) : sibs.every((x) => done(s, x.id));
					}
					if (ok) moves.push(["start", e.id]);
				} else if (s[e.id] === 2) moves.push(["finish", e.id]);
			}
		}
		return moves;
	};
	const related = (x, y) => { // y is an ancestor or a descendant of x
		for (let p = x.parent; p >= 0; p = ents[p].parent) if (p === y.id) return true;
		for (let p = y.parent; p >= 0; p = ents[p].parent) if (p === x.id) return true;
		return false;
	};
	const violates = (s) => {
		const running = ents.filter((e) => s[e.id] === 2);
		return running.some((x) => x.k === "E" && running.some((y) => y.id !== x.id && !related(x, y)));
	};
	const terminal = (s) => ents.every((e) => (e.top ? s[e.id] === 3 : s[e.id] === 0 || s[e.id] === 3));
	const seen = new Set(); let deadlock = false, isolation = false;
	const stack = [new Array(N).fill(0)];
	while (stack.length) {
		const s = stack.pop(); const k = s.join(""); if (seen.has(k)) continue; seen.add(k);
		if (violates(s)) isolation = true;
		const moves = enabled(s);
		if (moves.length === 0 && !terminal(s)) deadlock = true;
		for (const [kind, id] of moves) { const t = s.slice(); t[id] = kind === "invoke" ? 1 : kind === "start" ? 2 : 3; stack.push(t); }
	}
	return { deadlock, isolation, states: seen.size };
}
const describe = (c) => c.map((t, i) => `${t.k}${t.kids.length ? `(${t.kids.join("")})` : ""}`).join(" ");
const configs = [];
for (let n = 1; n <= 3; n++) { const rec = (acc) => { if (acc.length === n) { configs.push(acc); return; } for (const t of tops) rec([...acc, t]); }; rec([]); }
console.log(`configurations: ${configs.length} (1-3 top-level calls, each E/S, 0-2 children each E/S)\n`);
console.log("| variant | deadlock configs | isolation-violation configs | smallest deadlock | smallest violation |\n|---|---|---|---|---|");
const label = { A: "A naive FIFO", B: "B B1 lanes (no guards)", C: "C B1 + AF-5", D: "D B1 + AF-5 + AF-1a", E: "E full nested exclusion (+ AF-5)" };
let maxStates = 0;
for (const v of variants) {
	let dl = 0, iso = 0, firstDl, firstIso;
	for (const c of configs) { const r = explore(c, v); maxStates = Math.max(maxStates, r.states); if (r.deadlock) { dl++; if (!firstDl || describe(c).length < describe(firstDl).length) firstDl = c; } if (r.isolation) { iso++; if (!firstIso || describe(c).length < describe(firstIso).length) firstIso = c; } }
	console.log(`| ${label[v]} | ${dl} | ${iso} | ${firstDl ? describe(firstDl) : "-"} | ${firstIso ? describe(firstIso) : "-"} |`);
}
console.log(`\n(largest state space explored: ${maxStates} states; notation: E exclusive, S shared, children in brackets, calls in arrival order)`);
