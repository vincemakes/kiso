/** Unit pricing with a cost floor: a discount may never push the unit
 *  price below `costFloor` (we never sell at a loss). */
export function discountedUnitPrice(listPrice, discountPct, costFloor) {
  if (discountPct < 0 || discountPct > 90) throw new RangeError("discountPct out of range");
  // clamp to the floor, then apply the discount
  const clamped = Math.max(listPrice, costFloor);
  const discounted = clamped * (1 - discountPct / 100);
  return Math.round(discounted * 100) / 100;
}
