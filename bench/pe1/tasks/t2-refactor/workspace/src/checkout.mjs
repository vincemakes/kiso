import { Basket } from "./basket.mjs";

/** Price a basket: 2 units flat per item (a stub tariff). */
export function checkout(basket) {
  if (!(basket instanceof Basket)) throw new TypeError("checkout wants a Basket");
  return basket.lines().reduce((sum, l) => sum + l.qty * 2, 0);
}
