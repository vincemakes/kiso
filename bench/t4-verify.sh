#!/bin/sh
# T4 verify: the days-between test AND the release convention (the version
# bump is the skill-only knowledge — the tests in the repo must NOT leak
# it, so the check lives bench-side).
set -eu
cd "$1"
node tests/days-between.test.js > /dev/null 2>&1 || { echo fail; exit 0; }
V=$(node -e "console.log(require('./package.json').version)")
[ "$V" = "0.3.2" ] && echo pass || echo fail
