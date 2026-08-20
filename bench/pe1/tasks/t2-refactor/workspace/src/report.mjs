import { Basket } from "./basket.mjs";

export function describeBasket(basket) {
  if (!(basket instanceof Basket)) throw new TypeError("describeBasket wants a Basket");
  const n = basket.lines().length;
  return `${n} line${n === 1 ? "" : "s"}`;
}
