# The englishization fix round — 6 restored bodies + the D2 numbers + the second anchor remap

2026-08-07. Spec (Max review REVISE execution): restore the 6 destroyed
bodies (backup hashes 6cf93810 / 877d3924 / 4c39d4e1 / 25a5eda6 /
0d761aad / 186d4258) and the D2 dock-gate numbers (5f2b5ea), re-run the
rewrite, re-verify with the reviewer trio, force-push, and optionally
repair the tag set. All new commits in English.

## The defect (found by the Max review)

The first englishization pass built its message mapping from a
hand-written body table that covered only the commits with CHINESE
bodies. Six commits whose bodies were ALREADY ENGLISH fell into the
fallback branch — subject + trailer only — and their bodies were
destroyed (the trailer count stayed 159/159, which is why the round's
own verification missed it; only the pairwise body check catches it).
D2: the dock-gate sentence in the TUI v5 body lost its numbers (the
original "appears at 80 wide / cut at 50 wide, status intact" was
rendered as "wide: it appears; narrow: cut, status intact").

## The fix

1. Restore the 6 bodies VERBATIM from the mirror backup (they needed no
   translation — English already), under the current translated subjects,
   trailers preserved. D2 restores "appears at 80 wide / cut at 50 wide,
   status intact".
2. Second filter-repo pass, 7 message replacements only.
3. Reviewer trio (all verified):
   - ① all 225 commits' %ai|%ae|%an|%T pairwise identical with the
     backup (225/225, zero unmatched);
   - ② all 159 trailers pairwise identical (154 "Claude" + 5
     "Claude Fable 5");
   - ③ commit-map anchor remap: 14 tokens across 5 ADRs and 3 plan
     records remapped; every doc anchor resolves to a commit reachable
     from main (merge-base --is-ancestor). The two doc hex tokens that
     do not resolve (b3fa624e — a kiso session id; 617ec7d5 — a
     claude.ai artifact id) are non-commit identifiers, proven absent
     from the backup history, left verbatim.
4. Tag set repaired in the same force-push window: v0.1.23 / v0.1.24
   added (their releases were folded into the feature commits — the
   merge round 10ae6d2 / the TUI v4 round 19cbd86 — no chore(release)
   commit ever existed to tag); 0.1.20 deleted, v0.1.20 re-created at
   the same commit. The tag set is now uniformly v0.1.0..v0.1.29 (30).

## Acceptance

- Reviewer trio evidence above; the 6-body paragraph correspondence
  table in the report.
- CJK greps still zero: tracked tree 0 files, all messages 0.
- npm run check green (638 tests; the rewrite touches messages only).
- clean-tree two-line machine evidence: git status --short empty +
  origin/main..HEAD empty (forced-pushed).
- Mirror backup still in place at
  /Users/vinve/Desktop/devv/kiso-english-mirror-backup-20260806 (the
  rollback insurance for the forced push).
