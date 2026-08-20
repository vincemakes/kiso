/** The Journal records signed amounts. */
export class Journal {
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
