import { Cart } from "./cart.mjs";
export { checkout } from "./checkout.mjs";
export { describeCart as describeOrder } from "./report.mjs";

/** The stable public factory — tests depend on THIS name only. */
export function createOrder() {
  return new Cart();
}
