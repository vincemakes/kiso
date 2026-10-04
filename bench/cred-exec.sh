#!/bin/sh
# cred-exec.sh <command...> — the arm's credential, read HERE and nowhere
# else. The owner's rule: a key is read from its file and NEVER passes
# through any process's argv. The runners used to hand the arm
# `OPENAI_API_KEY=<key>` as an argument to `env -i`, which put the key in
# that process's argv for as long as it lived; they now hand it a PATH
# (BENCH_CRED_FILE) and the name the arm reads (BENCH_CRED_AS), and this
# reads the key inside the process that then becomes the arm.
#
# Only DEEPSEEK_API_KEY is taken from the file, in a subshell, so nothing
# else the file defines reaches the arm.
set -eu
: "${BENCH_CRED_FILE:?set BENCH_CRED_FILE to the credentials file path}"
: "${BENCH_CRED_AS:?set BENCH_CRED_AS to the variable the arm reads}"
# BENCH_CRED_KEY: the variable INSIDE the file (route.sh's ROUTE_CRED_KEY);
# DEEPSEEK_API_KEY when unset — every runner before the routes.
_kv=${BENCH_CRED_KEY:-DEEPSEEK_API_KEY}
case "$_kv" in
	*[!A-Z0-9_]*) echo "cred-exec: not a variable name: $_kv" >&2; exit 78 ;;
esac
_k=$( . "$BENCH_CRED_FILE" > /dev/null 2>&1; eval "printf '%s' \"\${$_kv:-}\"" )
[ -n "$_k" ] || { echo "cred-exec: the credentials file carries no $_kv" >&2; exit 78; }
case "$BENCH_CRED_AS" in
	*[!A-Z0-9_]*) echo "cred-exec: not a variable name: $BENCH_CRED_AS" >&2; exit 78 ;;
esac
eval "$BENCH_CRED_AS=\$_k; export $BENCH_CRED_AS"
unset _k _kv BENCH_CRED_FILE BENCH_CRED_AS BENCH_CRED_KEY
exec "$@"
