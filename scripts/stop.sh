#!/usr/bin/env bash
# Only stop Python/Node processes whose executable or cwd belongs to this checkout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v lsof >/dev/null 2>&1 || { echo "停止失败：需要 lsof" >&2; exit 1; }
count=0
while read -r pid command; do
  case "$command" in *uvicorn*|*vite*|*launcher.py*) ;; *) continue ;; esac
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
  case "$cwd/" in "$ROOT/"*) ;; *) continue ;; esac
  executable="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
  case "${executable##*/}" in python*|Python*|node) ;; *) continue ;; esac
  if kill -TERM "$pid" 2>/dev/null; then
    echo "[DingPan] 已请求停止 PID $pid"
    count=$((count + 1))
  fi
done < <(ps -ax -o pid= -o command=)
echo "[DingPan] 已向 $count 个当前项目进程发送停止信号"
