import { Cart } from "./cart.mjs";

/** Price a cart: 2 units flat per item (a stub tariff). */
export function checkout(cart) {
  if (!(cart instanceof Cart)) throw new TypeError("checkout wants a Cart");
  return cart.lines().reduce((sum, l) => sum + l.qty * 2, 0);
}
