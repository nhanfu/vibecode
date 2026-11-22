#!/usr/bin/env bash
# Functional check of the native command layer: launches the built shell with automation enabled,
# sends each case through the automation channel, and compares the response with the expectation.
#   usage: scripts/bridge-check.sh            (after: zig build -Dautomation=true)
# Each case in cases.tsv: <command>\t<payload json>\t<substring the response must contain>
set -u
cd "$(dirname "$0")/.."
BIN=./zig-out/bin/zn-probe
DIR=.zig-cache/zero-native-automation
CASES=scripts/bridge-cases.tsv
LOG=.zig-cache/bridge-check.log

pkill -x zn-probe 2>/dev/null; sleep 1
rm -rf "$DIR"; mkdir -p .zig-cache

# an isolated user-data folder: the user database is a copy of the real one (if any), so checks never write to it
DATA="$PWD/.zig-cache/test-userdata"
rm -rf "$DATA"; mkdir -p "$DATA"
REAL="$HOME/.config/TINJS Studio"
[ -f "$REAL/vibecode.duckdb" ] && cp "$REAL/vibecode.duckdb" "$DATA/" && [ -f "$REAL/vibecode.duckdb.wal" ] && cp "$REAL/vibecode.duckdb.wal" "$DATA/"
export STUDIO_USER_DATA="$DATA" VIBECODE_DB="$DATA/vibecode.duckdb"
"$BIN" >"$LOG" 2>&1 &
APP=$!
trap 'kill $APP 2>/dev/null' EXIT

for _ in $(seq 1 60); do grep -q "ready=true" "$DIR/snapshot.txt" 2>/dev/null && break; sleep 0.5; done
grep -q "ready=true" "$DIR/snapshot.txt" 2>/dev/null || { echo "FAIL app did not become ready (see $LOG)"; exit 1; }
# the page makes its own bridge calls at startup; their responses share the response file, so wait for them to finish
sleep 6

pass=0; fail=0; n=0
while IFS=$'\t' read -r command payload expect; do
  [ -z "$command" ] && continue
  n=$((n + 1)); id="case$n"
  response=""
  # the page also talks over the bridge while this runs, and its responses can overwrite ours: retry the case
  for _attempt in 1 2 3; do
    printf 'bridge {"id":"%s","command":"%s","payload":%s}\n' "$id" "$command" "$payload" > "$DIR/command.txt"
    for _ in $(seq 1 40); do
      response=$(cat "$DIR/bridge-response.txt" 2>/dev/null)
      case "$response" in *"\"id\":\"$id\""*) break 2 ;; esac
      sleep 0.25
    done
  done
  if [[ "$response" == *"\"id\":\"$id\""* && "$response" == *"$expect"* ]]; then
    pass=$((pass + 1)); echo "ok   $command"
  else
    fail=$((fail + 1)); echo "FAIL $command: expected '$expect' in: $response"
  fi
done < "$CASES"

echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
