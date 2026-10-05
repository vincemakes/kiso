/** The simulated settlement service: every call takes its time. */
export const settle = (ms) => new Promise((r) => setTimeout(r, ms));
