# route.sh — the provider route a kiso bench leg runs on (sourced).
#
# BENCH_ROUTE=ds (default): DeepSeek's official endpoint, the route every
# ceremony since 0.40 ran on. BENCH_ROUTE=co: DeepSeek V4.1 Flash through
# Command Code's provider API (the 0.46.0 evaluation, the owner's choice —
# the GOAT plan's credits). Both arms of a paired round MUST share a route:
# the gateway's model id is not the official one, so a co round's absolute
# numbers are not comparable with the history (kiso-doc
# plan-0460-3f-evaluation, rev 2).
#
# Sets: ROUTE_BASE_URL, ROUTE_MODEL, ROUTE_WINDOW (empty = the registry's),
# ROUTE_CRED_FILE (a PATH — the key never enters an argv; cred-exec.sh reads
# it inside the arm's own process) and ROUTE_CRED_KEY (the variable name
# inside that file).
BENCH_ROUTE=${BENCH_ROUTE:-ds}
case "$BENCH_ROUTE" in
	ds)
		ROUTE_BASE_URL="https://api.deepseek.com"
		ROUTE_MODEL="deepseek-flash"
		ROUTE_WINDOW=""
		ROUTE_CRED_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/claude-deepseek/credentials.env"
		ROUTE_CRED_KEY="DEEPSEEK_API_KEY"
		;;
	co)
		ROUTE_BASE_URL="https://api.commandcode.ai/provider/v1"
		ROUTE_MODEL="deepseek/deepseek-v4.1-flash"
		# an endpoint the registry does not key: the window is stated, as the
		# owner's own profile states it
		ROUTE_WINDOW="1000000"
		ROUTE_CRED_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/kiso-commandcode/credentials.env"
		ROUTE_CRED_KEY="COMMANDCODE_API_KEY"
		;;
	*)
		echo "route.sh: unknown BENCH_ROUTE '$BENCH_ROUTE' (ds | co)" >&2
		exit 1
		;;
esac
grep -q "^$ROUTE_CRED_KEY=\|^export $ROUTE_CRED_KEY=" "$ROUTE_CRED_FILE" 2>/dev/null || {
	echo "route.sh: no $ROUTE_CRED_KEY in $ROUTE_CRED_FILE" >&2
	exit 1
}
# the profile the arm binds: a NAMED profile, because `/model` only knows
# profiles (run-t5.sh's note). Written into the leg's KISO_HOME.
route_profile_json() {
	if [ -n "$ROUTE_WINDOW" ]; then
		printf '{ "models": { "ds": { "kind": "openai-compat", "model": "%s",\n  "baseUrl": "%s", "apiKeyEnv": "OPENAI_API_KEY", "contextWindow": %s } } }\n' "$ROUTE_MODEL" "$ROUTE_BASE_URL" "$ROUTE_WINDOW"
	else
		printf '{ "models": { "ds": { "kind": "openai-compat", "model": "%s",\n  "baseUrl": "%s", "apiKeyEnv": "OPENAI_API_KEY" } } }\n' "$ROUTE_MODEL" "$ROUTE_BASE_URL"
	fi
}

# THE REFERENCE ARM on this route (2026-10-07: every token comparison runs
# on the owner's route, DeepSeek V4.1 Flash through Command Code). The arm
# takes a custom provider from its MODEL STORE, one file in its bare home
# that the runner declares to the bareness gate. Its key is a COMMAND the
# arm runs per request (cred-print.sh), never a value in its environment
# and never a value on disk inside the leg: LB-2 (the launch bench) found an
# inherited key printed into a transcript by the arm's own shell tool.
# `reasoning: true` lets `--thinking` bind; `--thinking off` sends no
# effort field at all, which is what kiso sends when no effort is set
# (both measured against a local sink, 2026-10-07).
# route_ref_models_json <baseUrl> <cred-print path>
route_ref_models_json() {
	printf '{ "providers": { "route": { "baseUrl": "%s", "api": "openai-completions",\n  "apiKey": "!sh %s %s %s",\n  "models": [ { "id": "%s", "reasoning": true, "contextWindow": %s, "maxTokens": 384000 } ] } } }\n' \
		"$1" "$2" "$ROUTE_CRED_FILE" "$ROUTE_CRED_KEY" "$ROUTE_MODEL" "${ROUTE_WINDOW:-1000000}"
}
# The route's upstream host and path, for the capture proxy: the proxy
# forwards the request path unchanged, so the store names the path.
ROUTE_HOST=$(printf '%s' "$ROUTE_BASE_URL" | sed -E 's#^https?://([^/]+).*#\1#')
ROUTE_PATH=$(printf '%s' "$ROUTE_BASE_URL" | sed -E 's#^https?://[^/]+##')
# The reference arm's thinking level for the round's effort: `none` is the
# provider default, which the arm expresses as `off` (no field on the wire).
case "${BENCH_EFFORT:-high}" in
	none) REF_THINKING=off ;;
	*) REF_THINKING=${BENCH_EFFORT:-high} ;;
esac
# The reference binary: an absolute path pins the version under test (the
# kit records it); bare `pi` is whatever PATH resolves.
REF_BIN=${REF_BIN:-pi}
