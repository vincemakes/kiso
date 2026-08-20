/** The Ledger records signed amounts. */
export class Ledger {
  #entries = [];
  record(label, amount) {
    if (!Number.isFinite(amount)) throw new RangeError("amount must be finite");
    this.#entries.push({ label, amount });
    return this;
  }
  entries() {
    return [...this.#entries];
  }
}
