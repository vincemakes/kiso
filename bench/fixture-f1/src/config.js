/** Service configuration. Every value can be read here; a few can be overridden. */
export const config = {
	listing: { defaultPageSize: 25, maxPageSize: 200 },
	db: { path: process.env.INVENTORY_DB ?? "data/inventory.db", busyTimeoutMs: 5_000 },
	payments: { endpoint: process.env.PAYMENTS_URL ?? "https://payments.internal/v2", attempts: 4, backoffBaseMs: 150 },
	reports: { timezone: "UTC", hour: 2 },
};
