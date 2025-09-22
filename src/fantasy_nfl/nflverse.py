from __future__ import annotations

import gzip
import logging
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import httpx
import pandas as pd

from .settings import AppSettings

LOGGER = logging.getLogger(__name__)

PLAYER_MASTER_URL = "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv.gz"
WEEKLY_URL_TEMPLATE = "https://github.com/nflverse/nflverse-data/releases/download/player_stats/stats_player_week_{season}.csv.gz"

REQUIRED_PLAYER_COLUMNS = {"gsis_id", "espn_id", "display_name"}
REQUIRED_WEEKLY_COLUMNS = {"player_id", "season", "week"}


@dataclass
class NflverseDownloader:
    settings: AppSettings

    @property
    def base_dir(self) -> Path:
        return self.settings.data_root / "raw" / "nflverse"

    def fetch_players(self, force: bool = False) -> Path:
        dest = self.base_dir / "players.csv"
        if dest.exists() and not force:
            LOGGER.info("Using cached nflverse players at %s", dest)
            return dest
        self._download_and_extract(PLAYER_MASTER_URL, dest)
        self._validate_columns(dest, REQUIRED_PLAYER_COLUMNS)
        return dest

    def fetch_weekly(self, season: int, force: bool = False) -> Path:
        dest = self.base_dir / f"stats_player_week_{season}.csv"
        if dest.exists() and not force:
            LOGGER.info("Using cached nflverse weekly stats at %s", dest)
            return dest
        url = WEEKLY_URL_TEMPLATE.format(season=season)
        self._download_and_extract(url, dest)
        self._validate_columns(dest, REQUIRED_WEEKLY_COLUMNS)
        return dest

    def _download_and_extract(self, url: str, dest_csv: Path) -> None:
        dest_csv.parent.mkdir(parents=True, exist_ok=True)
        tmp_gz = dest_csv.with_suffix(dest_csv.suffix + ".download")
        LOGGER.info("Downloading %s", url)
        with httpx.stream("GET", url, follow_redirects=True, timeout=60.0) as response:
            response.raise_for_status()
            with tmp_gz.open("wb") as fh:
                for chunk in response.iter_bytes():
                    fh.write(chunk)
        LOGGER.debug("Download complete: %s (%s bytes)", tmp_gz, tmp_gz.stat().st_size)

        LOGGER.info("Extracting to %s", dest_csv)
        with gzip.open(tmp_gz, "rb") as gz_fh, dest_csv.open("wb") as out_fh:
            shutil.copyfileobj(gz_fh, out_fh)
        tmp_gz.unlink(missing_ok=True)

    def _validate_columns(self, csv_path: Path, required: Iterable[str]) -> None:
        LOGGER.debug("Validating columns for %s", csv_path)
        df = pd.read_csv(csv_path, nrows=1)
        missing = set(required) - set(df.columns)
        if missing:
            raise ValueError(f"File {csv_path} missing required columns: {sorted(missing)}")
        LOGGER.info("Validated %s with columns %s", csv_path, sorted(required))
