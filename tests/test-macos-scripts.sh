#!/usr/bin/env bash
# Fake process inventory: never signals a real process.
set -euo pipefail
TEST_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STOPPED=""
ps() {
  if [ "$1" = "-ax" ]; then
    printf '%s\n' '10001 python -m uvicorn app.main:app' '10002 python -m uvicorn app.main:app' '10003 node vite' '10004 bash launcher.py'
  else
    case "$2" in 10001|10002) echo python ;; 10003) echo node ;; 10004) echo bash ;; esac
  fi
}
lsof() {
  case "$3" in 10001|10003|10004) echo "n$TEST_ROOT/apps/server" ;; 10002) echo n/other/project ;; esac
}
kill() { STOPPED="$STOPPED $2"; }
source "$TEST_ROOT/scripts/stop.sh"
[ "$STOPPED" = " 10001 10003" ] || { echo "Wrong stop targets: $STOPPED" >&2; exit 1; }
echo "macOS stop ownership regression passed"
