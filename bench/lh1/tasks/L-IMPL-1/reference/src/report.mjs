import { balancesByCurrency } from "./ledger.mjs";
import { formatAmount } from "./money.mjs";
import { convert } from "./rates.mjs";

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const singleUsd = (entries) => entries.every((e) => (e.currency ?? "USD") === "USD");

/** One line per account per currency, sorted; a USD-only journal prints the legacy shape. */
export function balanceReport(entries) {
	const usdOnly = singleUsd(entries);
	const lines = [];
	for (const [account, inner] of [...balancesByCurrency(entries).entries()].sort((a, b) => byKey(a[0], b[0]))) {
		for (const [currency, minor] of [...inner.entries()].sort((a, b) => byKey(a[0], b[0]))) {
			lines.push(usdOnly ? `${account}  ${formatAmount(minor)}` : `${account}  ${formatAmount(minor, currency)} ${currency}`);
		}
	}
	return lines.join("\n");
}

/** Per account, its balance converted to `base` and summed; then TOTAL. */
export function fxReport(entries, base, rates) {
	const lines = [];
	let total = 0;
	for (const [account, inner] of [...balancesByCurrency(entries).entries()].sort((a, b) => byKey(a[0], b[0]))) {
		let sum = 0;
		for (const [currency, minor] of inner) sum += convert(minor, currency, base, rates);
		total += sum;
		lines.push(`${account}  ${formatAmount(sum, base)} ${base}`);
	}
	lines.push(`TOTAL  ${formatAmount(total, base)} ${base}`);
	return lines.join("\n");
}

/** postings, accounts, net — the net in `base` when one is given. */
export function summary(entries, base, rates) {
	const accounts = new Set(entries.map((e) => e.account)).size;
	if (base === undefined) {
		const net = entries.reduce((n, e) => n + e.amount, 0);
		return `postings ${entries.length}\naccounts ${accounts}\nnet ${formatAmount(net)}`;
	}
	const net = entries.reduce((n, e) => n + convert(e.amount, e.currency ?? "USD", base, rates), 0);
	return `postings ${entries.length}\naccounts ${accounts}\nnet ${formatAmount(net, base)} ${base}`;
}
