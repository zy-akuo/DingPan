"""Desktop launcher: start FastAPI then open pywebview window."""
from __future__ import annotations

import os
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
