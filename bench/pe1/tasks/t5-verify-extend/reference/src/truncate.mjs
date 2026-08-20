/** Shorten a slug to at most `max` chars, cutting only at dashes —
 *  except a first word longer than `max`, which hard-cuts. */
export function truncateSlug(slug, max) {
  if (!Number.isInteger(max) || max <= 0) throw new RangeError("max must be a positive integer");
  if (slug.length <= max) return slug;
  const head = slug.slice(0, max + 1);
  const cut = head.lastIndexOf("-");
  if (cut <= 0) return slug.slice(0, max);
  return head.slice(0, Math.min(cut, max)).replace(/-+$/, "");
}
