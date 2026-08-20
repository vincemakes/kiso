import { Basket } from "./basket.mjs";
export { checkout } from "./checkout.mjs";
export { describeBasket as describeOrder } from "./report.mjs";

/** The stable public factory — tests depend on THIS name only. */
export function createOrder() {
  return new Basket();
}
