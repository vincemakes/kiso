/** A line-per-event logger. */
export function log(level, message, fields = {}) {
	process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), level, message, ...fields })}\n`);
}
export const info = (m, f) => log("info", m, f);
export const warn = (m, f) => log("warn", m, f);
