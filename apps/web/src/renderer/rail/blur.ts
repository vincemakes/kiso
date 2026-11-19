/** Whether a blur is the person's own: a click or a Tab just before it. The page also moves focus by itself (to an approval's Allow
 *  button, say); that must not save a half-typed name, so a rename box that loses focus that way takes it back. */
let last = 0;
addEventListener("pointerdown", () => (last = Date.now()), true);
addEventListener("keydown", (e) => (e.key === "Tab" ? (last = Date.now()) : last), true);
export const byPerson = (): boolean => Date.now() - last < 600;
