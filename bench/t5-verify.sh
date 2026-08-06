#!/bin/sh
# T5 verify: the three final checks after the 8 progressive turns.
set -eu
cd "$1"
node tests/range.test.js > /dev/null 2>&1 \
  && node tests/report.test.js > /dev/null 2>&1 \
  && [ "$(node src/cli.js --count '1-2,3-4' | tail -1)" = "2" ] \
  && echo pass || echo fail
