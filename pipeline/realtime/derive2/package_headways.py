#!/usr/bin/env python3
"""
derive2 dataset packaging — "NYC Observed Bus Headways (beta)".

Rolls the per-day derived/observed_headways partitions into a published, downloadable
dataset under analysis/headways_dataset/:

  data/observed_bus_headways_YYYY-MM-DD.csv       (+ .parquet) one file per service day
  observed_bus_headways_all.parquet               concatenated (partitioned by local_date)
  datapackage.json                                Frictionless-style mini Data Package
  README.md                                       method / gaps / PRELIMINARY status / license

This is the novel public artifact: per route x stop x direction x hour observed headway
(median, CV, bunching) vs the scheduled headway, from OUR realtime archive — MTA does not
publish observed headways. Every file carries archive_depth_days + a PRELIMINARY flag
(<14 days of archive) and excludes hours flagged PARTIAL/known-gap in DATA_QUALITY.json.

License: CC-BY 4.0. Cadence: daily.
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import pandas as pd

from _common import ANALYSIS, DERIVED, now_iso

DATASET_DIR = ANALYSIS / "headways_dataset"
DATA_DIR = DATASET_DIR / "data"
HEADWAY_DIR = DERIVED / "observed_headways"
DQ_DIR = DERIVED / "data_quality"

PUBLISH_COLS = [
    "route_id", "direction_id", "stop_id", "stop_name", "local_date", "local_hour",
    "n_arrivals", "n_headways", "median_headway_s", "mean_headway_s", "headway_cv",
    "min_headway_s", "max_headway_s", "sched_median_headway_s", "headway_deviation_s",
    "bunch_share_lt50_sched", "bunch_share_lt50_obs", "bunching_index",
    "median_deviation_s", "archive_depth_days", "preliminary",
]


def _excluded_hours(day: str) -> set[int]:
    """Local hours to drop for this day, from the bus_vehicle_positions DATA_QUALITY flags."""
    dq = DQ_DIR / f"date={day}" / "DATA_QUALITY.json"
    if not dq.exists():
        return set()
    j = json.loads(dq.read_text())
    feed = j.get("feeds", {}).get("bus_vehicle_positions", {})
    # DATA_QUALITY hours are UTC; convert the excluded UTC hours to local (UTC-4)
    excl_utc = feed.get("exclude_from_stats_hours", [])
    return {(int(h) - 4) % 24 for h in excl_utc}


def build(min_headways: int = 2) -> dict:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    parts = sorted(glob.glob(str(HEADWAY_DIR / "date=*" / "part-000.parquet")))
    if not parts:
        return {"status": "no_input"}
    frames = []
    per_day = {}
    for p in parts:
        day = Path(p).parent.name.split("=", 1)[1]
        df = pd.read_parquet(p)
        if df.empty:
            continue
        excl = _excluded_hours(day)
        before = len(df)
        # exclude PARTIAL / gap local hours + thin cells
        df = df[~df["local_hour"].isin(excl)]
        df = df[df["n_headways"] >= min_headways]
        for c in PUBLISH_COLS:
            if c not in df.columns:
                df[c] = None
        df = df[PUBLISH_COLS].copy()
        # round the float seconds for a clean public file
        for c in ["median_headway_s", "mean_headway_s", "min_headway_s", "max_headway_s",
                  "sched_median_headway_s", "headway_deviation_s", "median_deviation_s"]:
            df[c] = pd.to_numeric(df[c], errors="coerce").round(1)
        for c in ["headway_cv", "bunch_share_lt50_sched", "bunch_share_lt50_obs",
                  "bunching_index"]:
            df[c] = pd.to_numeric(df[c], errors="coerce").round(4)
        # Name files by the UTC archive-day partition (1:1 with partitions, collision-free).
        # The true service time lives in the local_date / local_hour COLUMNS inside each file.
        csv_p = DATA_DIR / f"observed_bus_headways_{day}.csv"
        pq_p = DATA_DIR / f"observed_bus_headways_{day}.parquet"
        df.to_csv(csv_p, index=False)
        df.to_parquet(pq_p, index=False)
        per_day[day] = {"rows": int(len(df)), "excluded_local_hours": sorted(excl),
                        "rows_before_filter": int(before),
                        "local_dates": sorted(df["local_date"].dropna().unique().tolist())}
        frames.append(df)

    alldf = pd.concat(frames, ignore_index=True)
    alldf.to_parquet(DATASET_DIR / "observed_bus_headways_all.parquet", index=False)
    depth = int(alldf["archive_depth_days"].dropna().max()) if alldf["archive_depth_days"].notna().any() else len(per_day)
    preliminary = depth < 14

    dp = {
        "name": "nyc-observed-bus-headways",
        "title": "NYC Observed Bus Headways (beta)",
        "description": "Observed bus headways, headway variability (CV), bunching index, and "
                       "deviation from the scheduled headway, per route x stop x direction x "
                       "hour, derived from a self-collected MTA GTFS-realtime vehicle-position "
                       "archive. MTA publishes schedules, not observed headways.",
        "version": "0.1.0-beta",
        "created": now_iso(),
        "licenses": [{"name": "CC-BY-4.0",
                      "path": "https://creativecommons.org/licenses/by/4.0/",
                      "title": "Creative Commons Attribution 4.0"}],
        "attribution": "Jane / nycvisualizer. Underlying realtime feed (c) MTA (BusTime GTFS-rt).",
        "temporal_coverage": sorted(per_day),
        "archive_depth_days": depth,
        "status": "PRELIMINARY" if preliminary else "OK",
        "update_cadence": "daily",
        "row_grain": "route_id x direction_id x stop_id x local_date x local_hour",
        "known_gaps": ["2026-07-21T00:51Z..22:55Z poller suspended (disk guard); the affected "
                       "local hours are excluded per DATA_QUALITY.json"],
        "resources": [
            {"name": "observed_bus_headways_all", "path": "observed_bus_headways_all.parquet",
             "format": "parquet", "rows": int(len(alldf))},
        ] + [
            {"name": f"observed_bus_headways_{d}",
             "path": f"data/observed_bus_headways_{d}.csv", "format": "csv",
             "rows": per_day[d]["rows"]} for d in sorted(per_day)
        ],
        "fields": {c: "" for c in PUBLISH_COLS},
    }
    (DATASET_DIR / "datapackage.json").write_text(json.dumps(dp, indent=2))
    _write_readme(dp, per_day, depth, preliminary)
    return {"status": "ok", "days": len(per_day), "total_rows": int(len(alldf)),
            "archive_depth_days": depth, "preliminary": preliminary,
            "dataset_dir": DATASET_DIR.as_posix()}


def _write_readme(dp: dict, per_day: dict, depth: int, preliminary: bool) -> None:
    badge = "**PRELIMINARY** — " if preliminary else ""
    lines = [
        "# NYC Observed Bus Headways (beta)",
        "",
        f"{badge}Observed bus headways from a self-collected MTA GTFS-realtime archive. "
        "MTA publishes *scheduled* service; this dataset publishes what the buses **actually did** "
        "— observed headways, their variability, bunching, and the gap vs schedule.",
        "",
        f"- **Archive depth:** {depth} day(s). "
        + ("Reliability figures are **PRELIMINARY** until ≥14 days of archive."
           if preliminary else "Sufficient depth (≥14 days)."),
        "- **License:** CC-BY 4.0. Attribution: Jane / nycvisualizer; underlying feed © MTA.",
        "- **Update cadence:** daily.",
        f"- **Grain:** {dp['row_grain']}.",
        "",
        "## Method (summary — full detail in METHODS_derive2.md)",
        "",
        "1. Archive MTA BusTime GTFS-rt vehicle positions (~30s cadence).",
        "2. Map-match each ping to its GTFS shape offset in EPSG:2263; resample to 30s.",
        "3. Arrival = the trajectory crossing each stop's shape offset (fallback: first-seen "
        "per (trip, stop_id)). `current_status` is 100% NULL in this feed, so the legacy "
        "STOPPED_AT rule is NOT used.",
        "4. Observed headway = gap between consecutive arrivals at a stop for a route×direction; "
        "scheduled headway from GTFS `stop_times` for the active service day; bunching = headway "
        "CV and share of gaps < 50% of scheduled.",
        "",
        "## Honesty / gaps",
        "",
        "- The **2026-07-21 00:51Z–22:55Z** poller suspension (disk guard) is a known gap; the "
        "affected hours are **excluded** here (see the per-day `DATA_QUALITY.json`).",
        "- Cells with fewer than 2 observed headways are dropped.",
        "- Unmatched trips (no GTFS shape) fall back to first-seen detection or are excluded; the "
        "unmatched-trip rate is reported in the run summary (~0.6%).",
        "",
        "## Files",
        "",
        "| Service day | Rows | Excluded local hours |",
        "|---|---:|---|",
    ]
    for d in sorted(per_day):
        pd_ = per_day[d]
        lines.append(f"| {d} | {pd_['rows']:,} | {pd_['excluded_local_hours'] or '—'} |")
    lines += ["", "`observed_bus_headways_all.parquet` concatenates every day.", ""]
    (DATASET_DIR / "README.md").write_text("\n".join(lines), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-headways", type=int, default=2)
    args = ap.parse_args()
    print(json.dumps(build(min_headways=args.min_headways), indent=2))


if __name__ == "__main__":
    main()
