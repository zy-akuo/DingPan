#!/usr/bin/env bash
# 钉盘 macOS/Linux 开发脚本（由根目录 Makefile 调用，也可直接执行）
# Windows 用户请继续使用 start-dev.bat / start-desktop.bat，勿用本脚本。
# 用法:
#   bash scripts/dev.sh               # 一键开发：后端(reload)+前端(HMR)+自动开浏览器
#   bash scripts/dev.sh --setup-only  # 仅准备环境（uv/venv + 依赖）
#   bash scripts/dev.sh --desktop     # 构建(增量)并打开 pywebview 桌面窗口
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv"
HOST="127.0.0.1"
BACKEND_PORT="${DINGPAN_PORT:-17831}"
FRONTEND_PORT="5173"
MANAGED_NODE_DIR="$ROOT/.tools/node"

log() { echo "[DingPan] $*"; }
die() { echo "[DingPan] $*" >&2; exit 1; }

uv_bin() {
  if command -v uv >/dev/null 2>&1; then command -v uv
  elif [ -x "$HOME/.local/bin/uv" ]; then echo "$HOME/.local/bin/uv"
  else return 1; fi
}

pick_py311() { # 找系统已装的 Python 3.11+（无 uv 时的兜底）
  local c v
  for c in python3.13 python3.12 python3.11 python3; do
    command -v "$c" >/dev/null 2>&1 || continue
    v="$("$c" -c 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")' 2>/dev/null)" || continue
    case "$v" in 3.1[1-9]|3.[2-9]) echo "$c"; return 0 ;; esac
  done
  return 1
}

setup_env() {
  if [ -x "$VENV/bin/python" ] && "$VENV/bin/python" -c 'import sys; assert sys.version_info >= (3, 11)' 2>/dev/null; then
    log "复用现有 venv"
  else
    if UV="$(uv_bin)"; then
      log "用 uv 创建 venv（Python 3.11，本机缺失时 uv 会自动下载）..."
      rm -rf "$VENV"
      "$UV" venv "$VENV" --python 3.11
    else
      local PY
      PY="$(pick_py311)" || die "既没有 uv 也没有 Python 3.11+。建议安装 uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
      log "未检测到 uv，退回用 $PY 创建 venv..."
      rm -rf "$VENV"
      "$PY" -m venv "$VENV"
    fi
  fi
  # 幂等刷新后端依赖（已装齐时几乎瞬时）
  if UV="$(uv_bin)"; then
    VIRTUAL_ENV="$VENV" "$UV" pip install -q -r "$ROOT/apps/server/requirements.txt"
  else
    "$VENV/bin/python" -m pip install -q -r "$ROOT/apps/server/requirements.txt"
  fi
}

node_ok() { # vite 8 要求 Node >= 20.19
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const[a,b]=process.versions.node.split(".").map(Number);process.exit((a>20||(a===20&&b>=19))?0:1)' >/dev/null 2>&1
}

ensure_node() { # 系统 Node 过旧时，自动下载便携 Node 22 LTS 到 .tools/（不动系统 Node）
  if node_ok; then return; fi
  if [ -x "$MANAGED_NODE_DIR/bin/node" ]; then
    export PATH="$MANAGED_NODE_DIR/bin:$PATH"
    node_ok && return
  fi
  local arch ver tmp
  case "$(uname -m)" in arm64) arch="arm64" ;; *) arch="x64" ;; esac
  ver="v22.14.0"
  log "未找到 Node >= 20.19（当前 $(command -v node >/dev/null 2>&1 && node -v || echo 无)），下载便携 ${ver} 到 .tools/ ..."
  mkdir -p "$ROOT/.tools"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/${ver}/node-${ver}-darwin-${arch}.tar.gz" -o "$tmp/node.tar.gz"
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  rm -rf "$MANAGED_NODE_DIR"
  mv "$tmp/node-${ver}-darwin-${arch}" "$MANAGED_NODE_DIR"
  rm -rf "$tmp"
  export PATH="$MANAGED_NODE_DIR/bin:$PATH"
  node_ok || die "便携 Node 安装后仍不满足版本要求"
  log "已就绪便携 Node $(node -v)"
}

ensure_node_deps() {
  ensure_node
  if [ ! -d "$ROOT/apps/web/node_modules" ]; then
    log "安装前端依赖（首次较慢）..."
    (cd "$ROOT/apps/web" && npm install --no-fund --no-audit)
  fi
}

free_port() { # $1=端口 $2=进程关键词，仅自动清理匹配的残留进程
  local pid
  if pid="$(lsof -ti "tcp:$1" 2>/dev/null | head -n1)" && [ -n "$pid" ]; then
    if ps -p "$pid" -o command= 2>/dev/null | grep -qi "$2"; then
      log "端口 $1 被残留 $2 进程占用 (pid=$pid)，自动清理"
      kill "$pid" 2>/dev/null || true
      sleep 1
    else
      log "警告: 端口 $1 被其他进程占用 (pid=$pid)，$2 可能启动失败"
    fi
  fi
}

warn_port() {
  local pid
  if pid="$(lsof -ti "tcp:$1" 2>/dev/null | head -n1)" && [ -n "$pid" ]; then
    log "警告: 端口 $1 已被占用 (pid=$pid)，Vite 可能会换端口，注意下方输出"
  fi
}

cmd_dev() {
  setup_env
  ensure_node_deps
  free_port "$BACKEND_PORT" uvicorn
  warn_port "$FRONTEND_PORT"

  ( cd "$ROOT/apps/server" && exec "$VENV/bin/python" -m uvicorn app.main:app \
      --host "$HOST" --port "$BACKEND_PORT" --reload ) &
  BACKEND_PID=$!
  log "后端已启动 pid=$BACKEND_PID  http://$HOST:$BACKEND_PORT  (--reload)"

  cleanup() {
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    log "已停止全部进程"
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  ( sleep 3
    if command -v open >/dev/null 2>&1; then open "http://localhost:$FRONTEND_PORT/"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$FRONTEND_PORT/"
    fi ) &

  log "前端启动中  http://localhost:$FRONTEND_PORT  (Vite HMR；Ctrl+C 退出全部)"
  cd "$ROOT/apps/web" && npm run dev
}

cmd_desktop() {
  setup_env
  ensure_node_deps
  log "启动桌面窗口（launcher 会按需增量构建前端）..."
  cd "$ROOT/apps/desktop" && exec "$VENV/bin/python" launcher.py
}

case "${1:-dev}" in
  dev)            cmd_dev ;;
  --setup-only)   setup_env; ensure_node_deps; log "环境就绪: $VENV" ;;
  --desktop)      cmd_desktop ;;
  *)              die "用法: dev.sh [--setup-only|--desktop]" ;;
esac
