import { discountedUnitPrice } from "./pricing.mjs";

export function cartTotal(lines) {
  let total = 0;
  for (const { listPrice, qty, discountPct, costFloor } of lines) {
    total += qty * discountedUnitPrice(listPrice, discountPct, costFloor);
  }
  return Math.round(total * 100) / 100;
}
