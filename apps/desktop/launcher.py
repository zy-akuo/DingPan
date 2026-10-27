"""Desktop launcher: build frontend if stale, start FastAPI, open pywebview window."""
from __future__ import annotations

import ctypes
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


def _node_major(node_exe: Path) -> int:
    try:
        out = subprocess.run(
            [str(node_exe), "-v"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
        )
        raw = (out.stdout or out.stderr or "").strip().lstrip("v")
        return int(raw.split(".")[0]) if raw else 0
    except Exception:
        return 0


def _iter_node_candidates(root: Path) -> list[Path]:
    """收集可用 node.exe：便携目录 → nvm 多版本 → PATH。"""
    found: list[Path] = []
    seen: set[str] = set()

    def add(p: Path) -> None:
        try:
            key = str(p.resolve()).lower()
        except OSError:
            key = str(p).lower()
        if key in seen or not p.is_file():
            return
        seen.add(key)
        found.append(p)

    for rel in (
        Path(".tools") / "node" / "bin" / "node",
        Path(".tools") / "node" / "node.exe",
        Path(".tools") / "nodejs" / "node.exe",
    ):
        add(root / rel)

    nvm_roots = [
        Path(os.environ.get("NVM_HOME", "")),
        Path(os.environ.get("APPDATA", "")) / "nvm",
        Path(r"D:\nvm\nvm"),
        Path(r"C:\nvm4w"),
        Path(r"C:\nvm"),
    ]
    for nvm in nvm_roots:
        if not nvm.is_dir():
            continue
        versions: list[tuple[tuple[int, int, int], Path]] = []
        for child in nvm.iterdir():
            if not child.is_dir():
                continue
            name = child.name[1:] if child.name.startswith("v") else child.name
            parts = name.split(".")
            if len(parts) != 3 or not all(p.isdigit() for p in parts):
                continue
            exe = child / "node.exe"
            if exe.is_file():
                versions.append(((int(parts[0]), int(parts[1]), int(parts[2])), exe))
        for _, exe in sorted(versions, reverse=True):
            add(exe)

    for name in ("node", "node.exe"):
        which = shutil.which(name)
        if which:
            add(Path(which))
    return found


def _build_command() -> tuple[list[str], dict] | None:
    """返回 (构建命令, 环境变量)。优先 Node >= 20（Vite 8）；避免系统 Node 14 假成功。"""
    root = Path(__file__).resolve().parents[2]
    env = os.environ.copy()
    min_major = 20
    for node in _iter_node_candidates(root):
        if _node_major(node) < min_major:
            continue
        node_dir = str(node.parent)
        env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
        npm_cli = (
            root
            / ".tools"
            / "node"
            / "lib"
            / "node_modules"
            / "npm"
            / "bin"
            / "npm-cli.js"
        )
        if node.name == "node" and npm_cli.is_file() and node.parent.name == "bin":
            return [str(node), str(npm_cli), "run", "build"], env
        npm = node.parent / "npm.cmd"
        if not npm.is_file():
            npm = node.parent / "npm"
        if npm.is_file():
            return [str(npm), "run", "build"], env
        which_npm = shutil.which("npm") or shutil.which("npm.cmd")
        if which_npm:
            return [which_npm, "run", "build"], env
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
        print(
            "[DingPan] 未找到 Node.js >= 20 / npm，跳过前端构建"
            "（界面可能为旧版本；可用 nvm install 22 && nvm use 22）"
        )
        return
    cmd, env = build
    # Windows 默认 GBK 解码 npm/vite 的 UTF-8 日志会炸；强制 UTF-8 并容错替换
    env = dict(env)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    before = _dir_newest(dist) if dist.exists() else 0.0
    print("[DingPan] 检测到前端有更新，正在构建（静默）...")
    try:
        proc = subprocess.run(
            cmd,
            cwd=web,
            env=env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as e:
        print(f"[DingPan] 前端构建无法启动，继续启动（界面可能为旧版本或空白）：{e}")
        return
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "").strip()[-1500:]
        print(f"[DingPan] 前端构建失败，继续启动（界面可能为旧版本或空白）：\n{tail}")
        return
    if not dist.exists() or not (dist / "index.html").exists():
        print("[DingPan] 构建未产生 dist 目录，跳过同步")
        return
    after = _dir_newest(dist)
    if after <= before:
        print(
            "[DingPan] 前端 dist 未更新（可能 Node 过旧导致构建静默失败），"
            "跳过同步；请使用 Node >= 20 后重试"
        )
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


def _window_icon() -> str | None:
    """与浏览器 tab 同源的 favicon.ico（Windows 窗口标题栏/任务栏）。"""
    here = Path(__file__).resolve().parent
    meipass = Path(getattr(sys, "_MEIPASS", here))
    candidates = [
        here / "favicon.ico",
        here.parent / "web" / "public" / "favicon.ico",
        here.parent / "server" / "web_dist" / "favicon.ico",
        meipass / "favicon.ico",
        meipass / "web_dist" / "favicon.ico",
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    return None


def _set_windows_app_id(app_id: str = "DingPan.Desktop") -> None:
    """让任务栏按独立应用显示 Form.Icon，而不是归组到 python.exe。"""
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(app_id)
    except Exception:
        pass


def main() -> None:
    # 必须在创建任何窗口之前调用，否则任务栏仍用 Python 图标
    _set_windows_app_id()

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

        # pywebview 6.x：icon 在 start()，不在 create_window()
        icon = _window_icon()
        webview.create_window(
            "盯盘 · A股涨停盯盘",
            f"http://{HOST}:{PORT}/",
            width=1400,
            height=900,
            min_size=(1100, 700),
        )
        webview.start(**({"icon": icon} if icon else {}))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    main()
