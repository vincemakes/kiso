const currenciesOf = (entries) => new Set(entries.map((e) => e.currency ?? "USD"));
const assertSingle = (entries) => {
	if (currenciesOf(entries).size > 1) throw new Error("mixed currencies: use balancesByCurrency");
};

/** Balances per account (single-currency journals; the legacy shape). */
export function balances(entries) {
	assertSingle(entries);
	const out = new Map();
	for (const e of entries) out.set(e.account, (out.get(e.account) ?? 0) + e.amount);
	return out;
}

/** The sum over accounts starting with `prefix` (single-currency journals). */
export function totalsByPrefix(entries, prefix) {
	assertSingle(entries);
	let total = 0;
	for (const e of entries) if (e.account.startsWith(prefix)) total += e.amount;
	return total;
}

/** Map account → Map currency → minor units. */
export function balancesByCurrency(entries) {
	const out = new Map();
	for (const e of entries) {
		const c = e.currency ?? "USD";
		const inner = out.get(e.account) ?? new Map();
		inner.set(c, (inner.get(c) ?? 0) + e.amount);
		out.set(e.account, inner);
	}
	return out;
}

/** Map currency → minor units over accounts starting with `prefix`. */
export function totalsByPrefixByCurrency(entries, prefix) {
	const out = new Map();
	for (const e of entries) {
		if (!e.account.startsWith(prefix)) continue;
		const c = e.currency ?? "USD";
		out.set(c, (out.get(c) ?? 0) + e.amount);
	}
	return out;
}
