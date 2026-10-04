/** The balance of a list of entries: credits add, debits subtract. */
export function balance(entries) {
	let total = 0;
	for (const e of entries) total += e.kind === "credit" ? e.amount : -e.amount;
	return total;
}

/** A fee in whole cents, rounded half up. `rate` is a fraction (0.025 = 2.5%). */
export function fee(amountCents, rate) {
	return Math.floor(amountCents * rate);
}

/** What arrives after the fee is taken. */
export function net(amountCents, rate) {
	return amountCents - fee(amountCents, rate);
}
