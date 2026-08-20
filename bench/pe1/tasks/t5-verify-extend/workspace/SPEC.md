# truncateSlug(slug, max)

Shorten an already-slugified string to at most `max` characters:

- If the slug already fits, return it unchanged.
- Otherwise cut at the LAST dash at or before `max` so no word is cut
  mid-way, and strip any trailing dash.
- If the first word alone is longer than `max`, hard-cut that word at
  `max` characters (the only case a word may be cut).
- `max` must be a positive integer; otherwise throw RangeError.

Export it from src/index.mjs. Write tests for it.
