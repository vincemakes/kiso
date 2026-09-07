import { balances } from "./ledger.mjs";
import { formatAmount } from "./money.mjs";

/** One line per account, sorted: `account  amount`. */
export function balanceReport(entries) {
	const lines = [];
	for (const [account, minor] of [...balances(entries).entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
		lines.push(`${account}  ${formatAmount(minor)}`);
	}
	return lines.join("\n");
}

/** postings, accounts, net. */
export function summary(entries) {
	const accounts = new Set(entries.map((e) => e.account)).size;
	const net = entries.reduce((n, e) => n + e.amount, 0);
	return `postings ${entries.length}\naccounts ${accounts}\nnet ${formatAmount(net)}`;
}
