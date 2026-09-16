"""Fetch one historical week and write the website's weekly report."""
import argparse
from dataclasses import replace
import json

from fantasy_nfl.espn import EspnClient
from fantasy_nfl.settings import get_settings
from fantasy_nfl.week_report import build_week_report

parser = argparse.ArgumentParser()
parser.add_argument("--season", required=True, type=int)
parser.add_argument("--week", required=True, type=int)
parser.add_argument("--cached", action="store_true", help="Use an already fetched historical snapshot")
args = parser.parse_args()
settings = replace(get_settings(), espn_season=args.season)
raw = settings.data_root / "raw" / "espn" / str(args.season) / f"view-mMatchupScore-week-{args.week}.json"
if not args.cached:
    with EspnClient(settings) as client:
        snapshot = client.fetch_view("mMatchupScore", params={
            "view": ["mMatchup", "mMatchupScore", "mRoster", "mSettings", "mTeam"],
            "scoringPeriodId": args.week,
        })
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_text(json.dumps(snapshot))
else:
    snapshot = json.loads(raw.read_text())
report = build_week_report(snapshot, args.week)
dest = settings.data_root / "out" / "league" / str(args.season) / f"week_{args.week}.json"
dest.parent.mkdir(parents=True, exist_ok=True)
temp = dest.with_suffix(".tmp")
temp.write_text(json.dumps(report, indent=2))
temp.replace(dest)
print(json.dumps({"path": str(dest), "season": report["season"], "week": report["week"], "teams": len(report["teams"]), "complete": report["complete"], "lineupsReconciled": sum(t["lineupReconciled"] for t in report["teams"])}))
