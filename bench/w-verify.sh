#!/bin/sh
# w-verify.sh <repo> — W1 / W2 (ADR-0059 release 1): the tests are the
# fixture's (unchanged since the baseline commit) and the whole suite
# passes on the final tree. The chain itself (wakes, waits, the zero
# requests between) is the counters' and the kit's, never the verify's.
# Prints pass | fail.
set -u
R=$1
cd "$R" || { echo fail; exit 0; }
git diff --quiet HEAD -- tests/ package.json 2>/dev/null || { echo fail; exit 0; }
if node --test tests/*.test.js > "$R/../w-verify.log" 2>&1; then echo pass; else echo fail; fi
