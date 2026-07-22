#!/usr/bin/env python3
"""
Realtime derivation engine v2 (derive2) — shared helpers.

Public-repo hygiene: NO absolute workspace-root literals anywhere. The pipeline root is
resolved from the NYCV_PIPELINE_ROOT env var (the convention the poller / snapshot /
derive scripts share), falling back to the NYCPlatform dir two levels above this file
(realtime/derive2/_common.py -> derive2 -> realtime -> NYCPlatform).

S0 findings honored here:
  * current_status / current_stop_seq are 100% NULL in the bus vehicle-positions
    archive, so arrival detection is built on stop_id / shape-offset transitions, NOT
    on the legacy STOPPED_AT (current_status=1) rule (which yields ZERO rows).
  * The 2026-07-21T00:51Z -> 22:55Z archiving suspension is a known PARTIAL window;
    coverage is measured per feed per hour and partial hours are flagged / excluded.
"""
from __future__ import annotations

import os
from datetime import date, datetime, timezone
from pathlib import Path


def platform_root() -> Path:
    """Resolve the NYCPlatform root (env-parameterized, repo-portable)."""
    env = os.environ.get("NYCV_PIPELINE_ROOT")
    if env:
        return Path(env).resolve()
    return Path(__file__).resolve().parents[2]


PLATFORM = platform_root()
REALTIME = PLATFORM / "realtime"
ARCHIVE = Path(os.environ.get("NYCV_ARCHIVE_ROOT") or (REALTIME / "archive"))
DERIVED = REALTIME / "derived"
DERIVE2 = REALTIME / "derive2"
CACHE = DERIVE2 / "cache"
STATIC_ROOT = PLATFORM / "data" / "raw" / "transit_static"
ANALYSIS = PLATFORM / "analysis"

# Derived output partitions
TRAJ_DIR = DERIVED / "trajectories"
HEADWAY_DIR = DERIVED / "observed_headways"
ADHERENCE_DIR = DERIVED / "adherence"
KPI_DIR = DERIVED / "kpis"

# Bus GTFS static feeds (borough / operator). Route ownership is 1:1 (no collisions,
# verified): a route_id lives in exactly one of these feeds.
BUS_GTFS_FEEDS = [
    "gtfs_bus_bronx",
    "gtfs_bus_brooklyn",
    "gtfs_bus_manhattan",
    "gtfs_bus_mta_bus_company",
    "gtfs_bus_queens",
    "gtfs_bus_staten_island",
]

# EPSG for planar measurement (NY State Plane Long Island, US survey feet).
CRS_MEASURE = "EPSG:2263"
CRS_WGS84 = "EPSG:4326"

# ------- thresholds (documented in METHODS_derive2.md) -------
RESAMPLE_S = 30                 # trajectory resample cadence
MAX_HEADWAY_S = 7200           # cap observed headways (2h) — drop garbage gaps
MIN_HEADWAY_S = 30            # floor (below this = same vehicle double-report)
STOP_MATCH_TOL_FT = 660       # a ping "at" a stop within ~1/8 mile of its shape offset
MONO_BACKTRACK_FT = 500       # tolerated GPS jitter before a point is "non-monotonic"
BUNCH_SHORT_FRAC = 0.5        # gap < 0.5x scheduled -> counts toward bunching share
BUNCH_PAIR_FRAC = 0.25        # KPI: two arrivals < 0.25x sched headway apart = a pair
SPEED_MPH_CAP = 80            # GPS-jump outlier cap for segment speeds
COVERAGE_PARTIAL_FRAC = 0.60  # hour with < 60% of baseline rows -> PARTIAL, excluded

# Known poller-suspension window (S0). UTC. Rows in this window are PARTIAL for the
# high-volume feeds; the whole window is flagged in DATA_QUALITY.json.
KNOWN_GAPS = [
    {
        "start": "2026-07-21T00:51:00Z",
        "end": "2026-07-21T22:55:00Z",
        "reason": "poller_suspended_disk_guard",
        "feeds": ["bus_vehicle_positions", "bus_trip_updates", "citibike_station_status",
                  "subway_gtfs"],
        "note": "Rows buffered and partially flushed; some dropped above buffer cap. "
                "Hours in this window are PARTIAL and excluded from headway/bunching stats.",
    }
]

# High-volume feeds whose coverage matters for headway/bunching honesty.
HIGH_VOLUME_FEEDS = ["bus_vehicle_positions", "bus_trip_updates", "subway_gtfs",
                     "citibike_station_status"]

# GTFS-RT Alert `effect` enum -> severity tier (for KPI alert counts). MTA populates
# `effect`; there is no native severity field, so we bucket by service impact.
#   1 NO_SERVICE, 2 REDUCED_SERVICE, 3 SIGNIFICANT_DELAYS, 4 DETOUR, 5 ADDITIONAL_SERVICE,
#   6 MODIFIED_SERVICE, 7 OTHER_EFFECT, 8 UNKNOWN_EFFECT, 9 STOP_MOVED, 10 NO_EFFECT,
#   11 ACCESSIBILITY_ISSUE
ALERT_SEVERITY = {
    1: "high", 2: "high", 3: "high",
    4: "medium", 6: "medium", 9: "medium",
    5: "low", 7: "low", 8: "low", 10: "low", 11: "low",
}


def sched_id_for_date(d: date) -> None:
    """Placeholder kept for API symmetry; calendar resolution lives in gtfs_index."""
    return None


def utc_ts(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def in_known_gap(feed: str, day: str, hour: int) -> dict | None:
    """Return the gap record if (feed, day, hour) falls inside a known suspension."""
    hstart = utc_ts(f"{day}T{hour:02d}:00:00Z")
    hend = hstart + 3600
    for g in KNOWN_GAPS:
        if feed not in g["feeds"]:
            continue
        gs, ge = utc_ts(g["start"]), utc_ts(g["end"])
        if hstart < ge and hend > gs:  # overlap
            return g
    return None


def posix(p: Path) -> str:
    return p.as_posix()


def duck_list(files: list[Path]) -> str:
    """Render a python list of paths as a DuckDB parquet file-list literal."""
    return "[" + ",".join("'" + p.as_posix() + "'" for p in files) + "]"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
