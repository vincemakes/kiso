/** The Cart holds line items before checkout. */
export class Cart {
  #lines = [];
  add(sku, qty) {
    if (qty <= 0) throw new RangeError("qty must be positive");
    this.#lines.push({ sku, qty });
    return this;
  }
  lines() {
    return [...this.#lines];
  }
}
