import { Cart } from "./cart.mjs";

export function describeCart(cart) {
  if (!(cart instanceof Cart)) throw new TypeError("describeCart wants a Cart");
  const n = cart.lines().length;
  return `${n} line${n === 1 ? "" : "s"}`;
}
