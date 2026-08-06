---
name: repo-conventions
description: This repo's release convention — a feature that changes src/ bumps the PATCH digit of package.json (0.3.1 → 0.3.2). Never touch the version otherwise.
---
# repo-conventions

This repo's release convention, enforced by the maintainers:

- Every feature that adds or changes an export in `src/` bumps the PATCH
  digit of `package.json` (e.g. `0.3.1` → `0.3.2`).
- The version is NEVER changed for anything else (docs, tests-only edits,
  formatting).
- The bump is part of the SAME change — never a separate step.
