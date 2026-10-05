import { config } from "../config.js";
import { sleep } from "../util/sleep.js";
import { warn } from "../util/logger.js";

/** Pay for a restock order. Retries a failed call: `attempts` tries in all,
 *  waiting backoffBaseMs × 2^(n−1) before the n-th retry. */
export async function pay(order, send) {
	const { attempts, backoffBaseMs } = config.payments;
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await send(config.payments.endpoint, order);
		} catch (err) {
			lastError = err;
			if (attempt === attempts) break;
			warn("payment retry", { attempt });
			await sleep(backoffBaseMs * 2 ** (attempt - 1));
		}
	}
	throw lastError;
}
