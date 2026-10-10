from __future__ import annotations

import sys
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


def _default_data_dir() -> Path:
    # macOS: ~/Library/Application Support/DingPan
    # Windows: %APPDATA%\DingPan
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "DingPan"
    return Path.home() / "AppData" / "Roaming" / "DingPan"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="DINGPAN_", env_file=".env", extra="ignore")

    host: str = "127.0.0.1"
    port: int = 17831
    poll_interval_sec: float = 2.5
    idle_poll_interval_sec: float = 60.0
    data_dir: Path = _default_data_dir()
    serve_static: bool = True

    @property
    def db_path(self) -> Path:
        return self.data_dir / "dingpan.db"

    @property
    def config_path(self) -> Path:
        return self.data_dir / "user_config.json"


settings = Settings()
settings.data_dir.mkdir(parents=True, exist_ok=True)
