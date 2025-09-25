from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote

import httpx

from .settings import AppSettings

LOGGER = logging.getLogger(__name__)

BASE_URL = (
    "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/{season}/segments/0/leagues/{league_id}"
)
DEFAULT_VIEWS = ("mSettings", "mTeam", "mRoster", "mMatchup")


class EspnAuthError(RuntimeError):
    """Raised when ESPN authentication data is missing."""


class EspnClient:
    """Thin wrapper around ESPN league endpoints using stored cookies."""

    def __init__(self, settings: AppSettings) -> None:
        if not settings.espn_league_id or not settings.espn_season:
            raise EspnAuthError("ESPN_LEAGUE_ID and ESPN_SEASON must be set in the environment")

        if not settings.espn_s2 or not settings.espn_swid:
            raise EspnAuthError("ESPN_S2 and ESPN_SWID cookies are required for private league access")

        self.settings = settings
        self.base_url = BASE_URL.format(season=settings.espn_season, league_id=settings.espn_league_id)
        self.cookies = {
            "espn_s2": unquote(settings.espn_s2),
            "SWID": settings.espn_swid,
        }
        self._client = httpx.Client(
            timeout=httpx.Timeout(20.0),
            headers={
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
                "Accept": "application/json, text/plain, */*",
                "Referer": "https://fantasy.espn.com/football/",
            },
            cookies=self.cookies,
        )

    def fetch_view(self, view: str, params: dict[str, object] | None = None) -> dict:
        query_params: dict[str, object] = {"view": view}
        if params:
            query_params.update(params)

        LOGGER.debug("Fetching ESPN view %s with params %s", view, params)
        response = self._client.get(self.base_url, params=query_params)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:  # pragma: no cover - bubble meaningful message
            raise RuntimeError(
                f"ESPN API request failed for view '{view}' with status {exc.response.status_code}: {exc.response.text}"
            ) from exc
        return response.json()

    def fetch_views(self, views: Iterable[str]) -> dict[str, dict]:
        return {view: self.fetch_view(view) for view in views}

    def save_view(self, view: str, data: dict, suffix: str | None = None) -> Path:
        out_dir = self.settings.data_root / "raw" / "espn" / str(self.settings.espn_season)
        out_dir.mkdir(parents=True, exist_ok=True)
        filename = f"view-{view}{f'-{suffix}' if suffix else ''}.json"
        path = out_dir / filename
        path.write_text(json.dumps(data, indent=2))
        LOGGER.info("Saved ESPN view %s to %s", view, path)
        return path

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "EspnClient":  # pragma: no cover - context helper
        return self

    def __exit__(self, *exc_info: object) -> None:  # pragma: no cover - context helper
        self.close()


def ensure_views(views: Iterable[str] | None) -> list[str]:
    cleaned = [v.strip() for v in views or [] if v.strip()]
    return cleaned if cleaned else list(DEFAULT_VIEWS)
