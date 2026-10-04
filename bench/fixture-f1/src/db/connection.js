import { config } from "../config.js";
import { info } from "../util/logger.js";

/** An in-memory stand-in for the database at config.db.path. */
export function open(path = config.db.path) {
	info("db open", { path });
	const rows = new Map();
	return {
		get: (sku) => rows.get(sku),
		put: (sku, row) => void rows.set(sku, row),
		delete: (sku) => rows.delete(sku),
		all: () => [...rows.values()],
	};
}
