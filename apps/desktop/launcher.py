"""Desktop launcher: build frontend if stale, start FastAPI, open pywebview window."""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

HOST = os.environ.get("DINGPAN_HOST", "127.0.0.1")
PORT = int(os.environ.get("DINGPAN_PORT", "17831"))


def _server_root() -> Path:
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "server",
        Path(os.environ.get("DINGPAN_SERVER_ROOT", "")),
        Path(getattr(sys, "_MEIPASS", here)) / "server",
        here / "resources" / "server",
        here.parent / "resources" / "server",
    ]
    for c in candidates:
        if c and (c / "app").exists():
            return c
    return here.parent / "server"


def _source_layout() -> tuple[Path, Path, Path] | None:
    """返回 (web 源码目录, vite dist 目录, 服务端 web_dist 目录)；打包形态下返回 None。"""
    here = Path(__file__).resolve().parent  # apps/desktop
    web = here.parent / "web"
    server = here.parent / "server"
    if (web / "package.json").exists() and (server / "app").exists():
        return web, web / "dist", server / "web_dist"
    return None


def _build_command() -> tuple[list[str], dict] | None:
    """返回 (构建命令, 环境变量)。优先项目便携 Node（.tools/node，由 scripts/dev.sh 安装）。"""
    root = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    node = root / ".tools" / "node" / "bin" / "node"
    npm_cli = root / ".tools" / "node" / "lib" / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if node.exists() and npm_cli.exists():
        env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
        return [str(node), str(npm_cli), "run", "build"], env
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if npm:
        return [npm, "run", "build"], env
    return None


def _source_newest(web: Path) -> float:
    """前端源码（顶层配置文件 + src/ + public/）的最新 mtime。"""
    newest = 0.0
    for p in web.iterdir():
        if p.is_file() and p.suffix in (".ts", ".js", ".mjs", ".cjs", ".json", ".html"):
            newest = max(newest, p.stat().st_mtime)
    for sub in ("src", "public"):
        d = web / sub
        if d.is_dir():
            for p in d.rglob("*"):
                if p.is_file():
                    newest = max(newest, p.stat().st_mtime)
    return newest


def _dir_newest(d: Path) -> float:
    newest = 0.0
    for p in d.rglob("*"):
        if p.is_file():
            newest = max(newest, p.stat().st_mtime)
    return newest


def _sync_dist(dist: Path, web_dist: Path) -> None:
    try:
        shutil.rmtree(web_dist, ignore_errors=True)
        shutil.copytree(dist, web_dist)
    except OSError as e:
        print(f"[DingPan] 同步 dist -> web_dist 失败: {e}")


def ensure_frontend_build() -> None:
    """dist 缺失或源码比构建产物新时，静默执行 npm run build 并同步到 web_dist。

    打包形态（无 apps/web 源码目录）或缺少 npm 时静默跳过；不改变 Windows 原有打包流程。
    """
    if os.environ.get("DINGPAN_SKIP_BUILD") == "1":
        return
    layout = _source_layout()
    if not layout:
        return
    web, dist, web_dist = layout
    if dist.exists() and not web_dist.exists():
        _sync_dist(dist, web_dist)  # 沿用 web_dist 优先的静态目录约定
    if dist.exists() and _source_newest(web) <= _dir_newest(dist):
        return  # 产物已是最新，秒过
    build = _build_command()
    if not build:
        print("[DingPan] 未找到 npm，跳过前端构建（界面可能空白，请先运行 make setup 或安装 Node.js 20.19+）")
        return
    cmd, env = build
    print("[DingPan] 检测到前端有更新，正在构建（静默）...")
    proc = subprocess.run(cmd, cwd=web, env=env, capture_output=True, text=True)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-1500:]
        print(f"[DingPan] 前端构建失败，继续启动（界面可能为旧版本或空白）：\n{tail}")
        return
    if not dist.exists():
        print("[DingPan] 构建未产生 dist 目录，跳过同步")
        return
    _sync_dist(dist, web_dist)
    print("[DingPan] 前端构建完成")


def _wait_port(host: str, port: int, timeout: float = 45.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.25)
    return False


def main() -> None:
    ensure_frontend_build()
    server_root = _server_root()
    env = os.environ.copy()
    env["PYTHONPATH"] = str(server_root) + os.pathsep + env.get("PYTHONPATH", "")
    env["DINGPAN_HOST"] = HOST
    env["DINGPAN_PORT"] = str(PORT)

    python = sys.executable
    proc = subprocess.Popen(
        [python, "-m", "uvicorn", "app.main:app", "--host", HOST, "--port", str(PORT)],
        cwd=str(server_root),
        env=env,
    )

    try:
        if not _wait_port(HOST, PORT):
            raise RuntimeError("后端服务启动超时，请检查端口占用或依赖安装")
        import webview

        webview.create_window(
            "钉盘 · A股涨停盯盘",
            f"http://{HOST}:{PORT}/",
            width=1400,
            height=900,
            min_size=(1100, 700),
        )
        webview.start()
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
