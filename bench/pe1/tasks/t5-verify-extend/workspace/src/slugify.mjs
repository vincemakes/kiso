/** Lower-case, spaces and underscores to dashes, strip other
 *  punctuation, collapse dash runs, trim edge dashes. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}
