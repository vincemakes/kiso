#!/bin/sh
# run-e6ab.sh — the E6 pre-registered release A/B (round "e6ab"):
#   A = the PUBLISHED 0.3.0 bin (npx @vincemakes/kiso-code@0.3.0) — the
#       baseline: the /compact protocol on T5 (run-t5-e6.sh baseline).
#   B = the E6 policy tree dist — MECHANICAL-DROP armed (the 2026-08-14
#       crux verdict: drop 3/3 verify=pass vs auto 3/3 -> C wins, the
#       summary is an unnecessary mechanism; trigger 1300, keepRounds 2,
#       KISO_POLICY_DROP=1) on T5 (run-t5-e6.sh drop — the 2-process
#       shape: the driver's manual /compact line would preempt the policy
#       and double-fire at the turn-6 run's start).
# T3 (run-one.sh kiso T3): the policy CANNOT fire on either side — one
#   run, two inputs, the keepRounds floor (2 < 3) — restraint is the
#   feature, so T3 must stay FLAT.
# Interleaved A B B A A B B A A B, n=5 per side per leg, both cost
# metrics. Band baseline (pre-registered): the E5 v9 series rows
# (T3 1919.6-2478.4 / 9-14s, T5 13853.4-34536.4 / 53-100s).
# S1-1 verbatim: cheap-side out-of-band with all verify=pass and
# terminal-complete = improvement-class "proposed, for the reviewer" +
# a numbered finding; expensive-side out-of-band, or any out-of-band
# movement with a failed verify, stays blocker-class.
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
export KISO_ROUND=e6ab
for S in 01-A 02-B 03-B 04-A 05-A 06-B 07-B 08-A 09-A 10-B; do
  case "$S" in
    *-A)
      export KISO_BIN="npx -y @vincemakes/kiso-code@0.3.0" KISO_VERSION="0.3.0"
      unset KISO_POLICY_SUMMARY_TRIGGER KISO_POLICY_SUMMARY_KEEP KISO_POLICY_DROP
      ;;
    *-B)
      export KISO_BIN="node $B/../apps/cli/dist/index.js" KISO_VERSION="0.3.0"
      export KISO_POLICY_SUMMARY_TRIGGER=1300 KISO_POLICY_SUMMARY_KEEP=2
      unset KISO_POLICY_DROP
      ;;
  esac
  echo "=== T3 $S ==="
  "$B/run-one.sh" kiso T3 "$S"
done
for S in 01-A 02-B 03-B 04-A 05-A 06-B 07-B 08-A 09-A 10-B; do
  case "$S" in
    *-A)
      export KISO_BIN="npx -y @vincemakes/kiso-code@0.3.0" KISO_VERSION="0.3.0"
      unset KISO_POLICY_SUMMARY_TRIGGER KISO_POLICY_SUMMARY_KEEP KISO_POLICY_DROP
      ARM=baseline
      ;;
    *-B)
      export KISO_BIN="node $B/../apps/cli/dist/index.js" KISO_VERSION="0.3.0"
      export KISO_POLICY_SUMMARY_TRIGGER=1300 KISO_POLICY_SUMMARY_KEEP=2 KISO_POLICY_DROP=1
      ARM=drop
      ;;
  esac
  echo "=== T5 $S ($ARM) ==="
  "$B/run-t5-e6.sh" "$ARM" "$S"
done
echo "=== T6S leg: off 3 + on 3 (interleaved) ==="
for S in 1 2 3; do
  unset KISO_POLICY_SUMMARY_TRIGGER KISO_POLICY_SUMMARY_KEEP KISO_POLICY_DROP
  echo "=== T6S off-$S ==="
  "$B/run-e6-leg0.sh" off "$S"
  export KISO_POLICY_SUMMARY_TRIGGER=1300 KISO_POLICY_SUMMARY_KEEP=2 KISO_POLICY_DROP=1
  echo "=== T6S on-$S ==="
  "$B/run-e6-leg0.sh" on "$S"
done
echo "=== e6ab complete ==="
