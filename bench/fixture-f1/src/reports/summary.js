import { config } from "../config.js";
import { info } from "../util/logger.js";

/** The nightly summary: how many items, and how many units in stock. */
export function summary(items) {
	return {
		at: `${String(config.reports.hour).padStart(2, "0")}:00 ${config.reports.timezone}`,
		items: items.length,
		units: items.reduce((n, i) => n + i.quantity, 0),
	};
}
