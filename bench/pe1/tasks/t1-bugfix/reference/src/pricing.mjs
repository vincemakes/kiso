/** Unit pricing with a cost floor: a discount may never push the unit
 *  price below `costFloor` (we never sell at a loss). */
export function discountedUnitPrice(listPrice, discountPct, costFloor) {
  if (discountPct < 0 || discountPct > 90) throw new RangeError("discountPct out of range");
  const discounted = listPrice * (1 - discountPct / 100);
  const floored = Math.max(discounted, costFloor);
  return Math.round(floored * 100) / 100;
}
