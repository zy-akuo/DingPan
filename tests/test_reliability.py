"""Infrastructure regression tests, isolated from real user data and network."""
import asyncio
import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
from _test_env import DATA
sys.path.insert(0, str(ROOT / "apps/server"))
from app import db, main
from app.models import UserConfig
from fastapi import FastAPI
import httpx

spec = importlib.util.spec_from_file_location("desktop_launcher", ROOT / "apps/desktop/launcher.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class ReliabilityTests(unittest.TestCase):
    def test_atomic_config_preserves_original_if_replace_fails(self):
        db.save_user_config(UserConfig())
        original = db.settings.config_path.read_bytes()
        with patch.object(db.os, "replace", side_effect=OSError("simulated interruption")):
            with self.assertLogs("app.db", level="ERROR"), self.assertRaises(OSError):
                db.save_user_config(UserConfig())
        self.assertEqual(db.settings.config_path.read_bytes(), original)
        self.assertEqual(list(Path(DATA.name).glob("*.tmp")), [])

    def test_config_roundtrip_and_corrupt_file_preserved(self):
        cfg = UserConfig()
        cfg.watchlist = ["000001"]
        db.save_user_config(cfg)
        self.assertEqual(db.load_user_config().watchlist, ["000001"])
        db.settings.config_path.write_text("{broken", encoding="utf-8")
        with self.assertLogs("app.db", level="WARNING"):
            db.load_user_config()
        self.assertEqual(db.settings.config_path.read_text(encoding="utf-8"), "{broken")

    def test_node_version_boundaries(self):
        for version, expected in [("18.20.0", False), ("20.18.0", False),
                                  ("20.19.0", True), ("21.7.0", False),
                                  ("22.11.0", False), ("22.12.0", True), ("24.0.0", True)]:
            with self.subTest(version=version):
                result = type("Result", (), {"stdout": "v" + version, "stderr": "", "returncode": 0})()
                with patch.object(launcher.subprocess, "run", return_value=result):
                    self.assertEqual(launcher._node_supported(Path("node")), expected)

    def test_static_files_and_spa_without_directory_escape(self):
        async def check():
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                fake_main = root / "apps/server/app/main.py"
                static = root / "apps/server/web_dist"
                static.mkdir(parents=True)
                (static / "index.html").write_text("SPA", encoding="utf-8")
                (static / "ok.txt").write_text("allowed", encoding="utf-8")
                (static.parent / "secret.txt").write_text("secret", encoding="utf-8")
                application = FastAPI()
                with patch.object(main, "__file__", str(fake_main)):
                    main.mount_static(application)
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=application), base_url="http://test") as client:
                    self.assertEqual((await client.get("/ok.txt")).text, "allowed")
                    self.assertEqual((await client.get("/some/spa/route")).text, "SPA")
                    self.assertEqual((await client.get("/%2e%2e/secret.txt")).status_code, 404)
                    self.assertEqual((await client.get("/%2e%2e%5csecret.txt")).status_code, 404 if os.name == "nt" else 200)
                    endpoint = next(r.endpoint for r in application.routes if getattr(r, "path", "") == "/{full_path:path}")
                    from fastapi import HTTPException
                    with self.assertRaises(HTTPException):
                        await endpoint(str(static.parent / "secret.txt"))
        asyncio.run(check())


def tearDownModule():
    async def close():
        await main.ths_client.aclose()
        await main.market_service.client.aclose()
    asyncio.run(close())
    # Shared fixture is removed at process exit.
