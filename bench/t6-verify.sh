#!/bin/sh
# T6 verify: the final contract of the 24-turn chain. The fixture's tests
# carry the whole range/report API (the progressive tasks build toward
# them); the cli flag outputs are checked bench-side (the exact print
# formats are part of the chain's turns 14-17, 22-23).
set -eu
cd "$1"
for t in range report user clamp; do
	node "tests/$t.test.js" > /dev/null 2>&1 || { echo fail; exit 0; }
done
[ "$(node src/cli.js --count '1-2,3-4')" = "2" ] || { echo fail; exit 0; }
[ "$(node src/cli.js --span '1-2,3-4')" = "4" ] || { echo fail; exit 0; }
[ "$(node src/cli.js --sum '1-2,3-4')" = "4" ] || { echo fail; exit 0; }
[ "$(node src/cli.js --merged '1-2,2-5')" = "1-5" ] || { echo fail; exit 0; }
[ "$(node src/cli.js --distinct '1-2,3-4')" = "4" ] || { echo fail; exit 0; }
[ "$(node src/cli.js --pairs '1-2,2-3')" = "1" ] || { echo fail; exit 0; }
echo pass
