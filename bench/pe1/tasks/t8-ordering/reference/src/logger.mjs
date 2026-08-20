import { getConfig } from "./config.mjs";

const ORDER = { debug: 0, info: 1, warn: 2 };

export function log(level, message) {
  const threshold = ORDER[getConfig().logLevel] ?? 1;
  if (ORDER[level] === undefined || ORDER[level] < threshold) return;
  console.log(`[${level}] ${message}`);
}
