#!/usr/bin/env python3
"""Offline: PYTHONPATH=src python scripts/build-week-moments.py --season 2026 --week 1.

Requires data/raw/espn/2026/view-mMatchupScore-week-1.json (historical combined
mMatchup/mMatchupScore/mRoster views), data/raw/nflverse/play_by_play_2026.csv,
data/raw/nflverse/players.csv, and config/scoring-2026.yaml. No network or AI calls.
Only the researched Realzy/Mr. Beastsaw matchup is supported. Fresh seasons/weeks
must be investigated before this evidence template can be extended.
"""
from argparse import ArgumentParser
from pathlib import Path

from fantasy_nfl.week_moments import write_week_one_moments


def main() -> None:
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--week", type=int, required=True)
    parser.add_argument("--data-root", type=Path, default=Path("data"))
    parser.add_argument("--config", "--scoring", dest="scoring", type=Path,
                        default=Path("config/scoring-2026.yaml"))
    args = parser.parse_args()
    print(write_week_one_moments(args.data_root, args.scoring, args.season, args.week))


if __name__ == "__main__":
    main()
