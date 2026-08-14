#!/bin/sh
# run-e5ab.sh — the E5 pre-registered release A/B (round "e5ab"):
#   A = the PUBLISHED 0.2.2 bin (npx @vincemakes/kiso-code@0.2.2) — the FLAT
#       arm: the task extension is still built into the default composition
#       (the bench rent ledger carries system:ext:task + tool:task_set).
#   B = the tree dist — the OFF arm: the E5 composition (task left the
#       default; rent carries no task surfaces).
# Interleaved order A B B A A B B A A B, n=5 per side per leg, T3 leg then
# T5 leg, both cost metrics. Band baseline (pre-registered): the v9 series
# rows (T3 1919.6-2478.4 / 9-14s, T5 13853.4-34536.4 / 53-100s).
set -eu
B="$(cd "$(dirname "$0")" && pwd)"
export KISO_ROUND=e5ab
for S in 01-A 02-B 03-B 04-A 05-A 06-B 07-B 08-A 09-A 10-B; do
  case "$S" in
    *-A) export KISO_BIN="npx -y @vincemakes/kiso-code@0.2.2" KISO_VERSION="0.2.2" ;;
    *-B) export KISO_BIN="node $B/../apps/cli/dist/index.js" KISO_VERSION="0.2.2" ;;
  esac
  echo "=== T3 $S ($KISO_VERSION) ==="
  "$B/run-one.sh" kiso T3 "$S"
done
for S in 01-A 02-B 03-B 04-A 05-A 06-B 07-B 08-A 09-A 10-B; do
  case "$S" in
    *-A) export KISO_BIN="npx -y @vincemakes/kiso-code@0.2.2" KISO_VERSION="0.2.2" ;;
    *-B) export KISO_BIN="node $B/../apps/cli/dist/index.js" KISO_VERSION="0.2.2" ;;
  esac
  echo "=== T5 $S ($KISO_VERSION) ==="
  "$B/run-t5.sh" kiso "$S"
done
echo "=== e5ab complete ==="
