#!/bin/sh
# cred-print.sh <credentials file> <VARIABLE> — print one variable's value
# and nothing else. For an arm that takes its key from a command at request
# time (the reference arm's model store, route.sh): the key then never sits
# in that arm's environment, where its shell tool would inherit it, and
# never in a file inside the leg. Exits 78 (EX_CONFIG) when the file does not
# carry the variable; the value is never echoed in an error.
set -eu
_f=${1:?usage: cred-print.sh <file> <VARIABLE>}
_kv=${2:?usage: cred-print.sh <file> <VARIABLE>}
case "$_kv" in
	*[!A-Z0-9_]*) echo "cred-print: not a variable name: $_kv" >&2; exit 78 ;;
esac
_k=$( . "$_f" > /dev/null 2>&1; eval "printf '%s' \"\${$_kv:-}\"" )
[ -n "$_k" ] || { echo "cred-print: the credentials file carries no $_kv" >&2; exit 78; }
printf '%s' "$_k"
