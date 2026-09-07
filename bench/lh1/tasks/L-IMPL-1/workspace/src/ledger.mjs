/** Balances per account, in minor units. */
export function balances(entries) {
	const out = new Map();
	for (const e of entries) out.set(e.account, (out.get(e.account) ?? 0) + e.amount);
	return out;
}

/** The sum over accounts starting with `prefix`. */
export function totalsByPrefix(entries, prefix) {
	let total = 0;
	for (const e of entries) if (e.account.startsWith(prefix)) total += e.amount;
	return total;
}
