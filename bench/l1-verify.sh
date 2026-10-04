#!/bin/sh
# l1-verify.sh <repo> — L1 (slow tests): the tests are the fixture's
# (unchanged since the baseline commit) and the whole suite passes on the
# final tree. Prints pass | fail.
set -u
R=$1
cd "$R" || { echo fail; exit 0; }
git diff --quiet HEAD -- tests/ package.json 2>/dev/null || { echo fail; exit 0; }
if npm test > "$R/../l1-verify.log" 2>&1; then echo pass; else echo fail; fi
