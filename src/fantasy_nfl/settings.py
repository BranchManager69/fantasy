from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv


@dataclass
class AppSettings:
    """Application configuration sourced from environment variables."""

    espn_email: Optional[str]
    espn_password: Optional[str]
    espn_s2: Optional[str]
    espn_swid: Optional[str]
    espn_league_id: Optional[str]
    espn_season: Optional[int]
    data_root: Path
    log_level: str

    @property
    def masked_email(self) -> Optional[str]:
        if not self.espn_email:
            return None
        name, _, domain = self.espn_email.partition("@")
        if len(name) <= 2:
            return f"***@{domain}" if domain else "***"
        return f"{name[0]}***{name[-1]}@{domain}" if domain else f"{name[0]}***{name[-1]}"

    def masked_cookie(self, value: Optional[str]) -> Optional[str]:
        if not value:
            return None
        return f"{value[:4]}***{value[-4:]}" if len(value) > 8 else "***"


def _coerce_int(value: Optional[str]) -> Optional[int]:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except ValueError:
        raise ValueError(f"Expected integer-compatible value, got: {value!r}") from None


@lru_cache(maxsize=1)
def get_settings(env_path: Optional[Path | str] = None) -> AppSettings:
    """Load settings from `.env` (if present) and environment variables."""

    env_file = Path(env_path) if env_path else Path(".env")
    if env_file.exists():
        load_dotenv(env_file)

    data_root = Path(os.getenv("DATA_ROOT", "./data")).resolve()

    return AppSettings(
        espn_email=os.getenv("ESPN_EMAIL"),
        espn_password=os.getenv("ESPN_PASSWORD"),
        espn_s2=os.getenv("ESPN_S2"),
        espn_swid=os.getenv("ESPN_SWID"),
        espn_league_id=os.getenv("ESPN_LEAGUE_ID"),
        espn_season=_coerce_int(os.getenv("ESPN_SEASON")),
        data_root=data_root,
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )


def reset_settings_cache() -> None:
    """Clear cached settings—useful for tests."""

    get_settings.cache_clear()  # type: ignore[attr-defined]
