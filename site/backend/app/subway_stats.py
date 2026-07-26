"""Subway stats (W6b P2 consumer) — the read side of the derive2 SUBWAY chain.

A self-contained `APIRouter` (`/api/subwaystats/*`). The producer is
`realtime/derive2/subway_headways.py`, which shipped 2026-07-25 and until now had NO
reader at all. Every column name, unit and honesty flag below is taken from that module
and from `realtime/derive2/METHODS_derive2.md` §9 — nothing here is guessed and nothing
here is computed from a schedule.

Endpoints
---------
  GET /api/subwaystats/                    index + archive depth + the not_supported block
  GET /api/subwaystats/completeness        subway archive completeness from the META.json files
  GET /api/subwaystats/profile             time-of-day OBSERVED-headway profile by local hour
  GET /api/subwaystats/routes              per-route rollup (equal-weight routes)
  GET /api/subwaystats/station/{id}        one parent station: routes, hours, dwell, arrivals
  GET /api/subwaystats/runs                observed origin-to-last-stop run times per route

Reads (all under config.DERIVED_ROOT — never the raw archive, never GTFS static)
-------------------------------------------------------------------------------
  subway_headways/date=*/part-000.parquet      route x direction x parent station x local hour
  subway_headways/date=*/arrivals-000.parquet  one row per contiguous STOPPED_AT run
  subway_headways/date=*/runs-000.parquet      one row per (feed, trip_id)
  subway_headways/date=*/META.json             depth, per-feed coverage, `not_derived`
  data_quality/date=*/DATA_QUALITY.json        the `subway_gtfs` slice, for the bus-comparable
                                               equivalent-complete-days number

THE HONESTY CONSTRAINT — read this before adding anything
---------------------------------------------------------
The realtime subway `trip_id` does NOT join the GTFS-static subway `trip_id`: **0 of 8,040**
exact matches, and a suffix join reached only 74.19% of trips / 80.76% of rows on
2026-07-23. `subway_headways.py:485-493` therefore emits SEVEN columns as explicit NULLs on
every single cell — `sched_median_headway_s`, `headway_deviation_s`, `median_deviation_s`,
`bunch_share_lt50_sched`, `bunch_share_lt50_obs`, `bunching_index`, `direction_id` — with
`sched_basis = 'not_joined_pending'` and
`bunching_basis = 'withheld_no_schedule_denominator'`.

Consequently THIS MODULE NEVER EMITS a subway delay, on-time rate, schedule deviation,
adherence figure or bunching number, and never computes one either. `bunch_share_lt50_obs`
is arithmetically computable without a schedule; the derivation withholds it on purpose and
so does this reader. `/completeness` re-verifies the seven columns are still 100% NULL on
every request-cycle (cached) and publishes the counts, so a future producer regression that
started populating them would be visible here rather than silently rendered.

What IS honest and populated, and is all this module publishes: `median_headway_s`,
`mean_headway_s`, `min/max_headway_s`, `headway_cv`, `n_headways`, `n_arrivals`,
`median_dwell_s`, `dwell_censored_share`, `median_arr_uncertainty_s`,
`arrival_method='stopped_at_run'`, plus the honesty flags `exclude_from_stats`,
`known_gap_share`, `hour_partial_share`, `min_hour_poll_coverage`, `preliminary`,
`archive_depth_days`.

Direction
---------
The derivation's `direction` column is the trailing `N`/`S` of the NYCT `stop_id`, verified
to agree with the trip_id's own direction character on 99.989% of rows. It is NOT the GTFS
`direction_id` (that column is 0 on 100% of rows including southbound ones — a proto2
default — and is emitted NULL). `N`/`S` are NYCT service directions, not compass bearings.

Time base
---------
NYC is EDT (UTC-4) for the whole archive window. The parquet already carries `local_date`
and `local_hour` columns computed on that offset, so every query here filters and groups on
those COLUMNS and never on the hive `date=` partition value. A LOCAL day straddles two UTC
partitions; reading the column is what makes that invisible and correct.

Precision
---------
A ~7-equivalent-day archive does not support three decimals. Minutes are published to 1
decimal, shares to 2, coefficients of variation to 2. Seconds are published as integers-ish
(1 decimal) because the underlying poll clock is 30 s and finer digits would be theatre.
"""
from __future__ import annotations

import csv
import io
import json
import os
import time
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import duckdb
from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from . import config

router = APIRouter(prefix="/api/subwaystats", tags=["subwaystats"])


# --------------------------------------------------------------------------- #
# Tunables. Read from os.environ HERE (config.py is owned elsewhere); every default
# is documented and every threshold is echoed in the response so a reader can see the
# rule that produced the number.
# --------------------------------------------------------------------------- #
def _envi(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except Exception:
        return default


def _envf(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except Exception:
        return default


# --- suppression floors (publish nothing below these; say so rather than publish noise) ---
# METHODS_derive2.md §9.5: "Consumers should require n_headways >= 2, as the published bus
# dataset already does." 3 is that bar with one gap of margin.
MIN_CELL_HEADWAYS = _envi("NYCV_SS_MIN_CELL_HEADWAYS", 3)
# per PUBLISHED local-hour row of /profile
MIN_HOUR_HEADWAYS = _envi("NYCV_SS_MIN_HOUR_HEADWAYS", 20)
MIN_HOUR_CELLS = _envi("NYCV_SS_MIN_HOUR_CELLS", 3)
# before a route joins the /routes rollup
MIN_ROUTE_HEADWAYS = _envi("NYCV_SS_MIN_ROUTE_HEADWAYS", 50)
# before a station is published in /station/{id}
MIN_STATION_HEADWAYS = _envi("NYCV_SS_MIN_STATION_HEADWAYS", 20)
# before a route publishes an origin-to-last-stop run time. METHODS_derive2.md §9.6 records
# that routes 1/2/3 hold only 60/29/46 qualifying runs each and "fall below any reasonable
# publication floor"; 100 is that floor made explicit and overridable.
MIN_RUNS = _envi("NYCV_SS_MIN_RUNS", 100)

# --- day completeness (same shape as the bus rule so the two numbers are comparable) ---
COMPLETE_DAY_FRAC = _envf("NYCV_SS_COMPLETE_DAY_FRAC", 0.85)

# --- cache ---
# The derived tree is rewritten by derive2 on a daily/hourly cadence, so a long TTL costs
# nothing in freshness and removes the parquet scan from the request path entirely.
CACHE_TTL_S = _envf("NYCV_SS_CACHE_TTL_S", 900.0)

_SUBWAY_DIR = "subway_headways"
_ALERT_DIR = "subway_alert_exposure"
# The single subway feed DATA_QUALITY.json tracks, and therefore the only one whose
# completeness is measured on the SAME rule as the bus feed. The other seven are measured
# from the subway META.json poll census instead — both are published, labelled.
_DQ_FEED = "subway_gtfs"

# The seven columns the derivation NULLs on purpose. Never rendered; only counted.
WITHHELD_COLUMNS = (
    "sched_median_headway_s",
    "headway_deviation_s",
    "median_deviation_s",
    "bunch_share_lt50_sched",
    "bunch_share_lt50_obs",
    "bunching_index",
    "direction_id",
)


# --------------------------------------------------------------------------- #
# DuckDB plumbing — fresh in-memory connection, explicit file lists
# --------------------------------------------------------------------------- #
def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    return con


def _q(s: Any) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _plist(paths: list[str]) -> str:
    return "[" + ",".join(_q(p) for p in paths) + "]"


def _read(paths: list[str]) -> str:
    return f"read_parquet({_plist(paths)}, union_by_name=true)"


def _partition_files(kind: str) -> list[str]:
    """Sorted POSIX paths of every `subway_headways/date=*/<kind>` that exists."""
    base = config.DERIVED_ROOT / _SUBWAY_DIR
    if not base.exists():
        return []
    out: list[str] = []
    for p in sorted(base.glob("date=*")):
        f = p / kind
        if f.exists():
            out.append(f.as_posix())
    return out


def _cell_files() -> list[str]:
    return _partition_files("part-000.parquet")


def _arrival_files() -> list[str]:
    return _partition_files("arrivals-000.parquet")


def _run_files() -> list[str]:
    return _partition_files("runs-000.parquet")


# --------------------------------------------------------------------------- #
# tiny TTL cache (same pattern as autostats.py / obs.py)
# --------------------------------------------------------------------------- #
_ttl_cache: dict[str, tuple[float, Any]] = {}


def _cached(key: str, ttl: float, fn):
    now = time.time()
    hit = _ttl_cache.get(key)
    if hit is not None and (now - hit[0]) < ttl:
        return hit[1]
    val = fn()
    _ttl_cache[key] = (now, val)
    return val


# --------------------------------------------------------------------------- #
# rounding — precision matched to the evidence, not to the float
# --------------------------------------------------------------------------- #
def _min1(seconds: float | None) -> float | None:
    """Seconds -> minutes, 1 decimal. A 30 s poll clock does not support more."""
    return None if seconds is None else round(float(seconds) / 60.0, 1)


def _sec1(seconds: float | None) -> float | None:
    return None if seconds is None else round(float(seconds), 1)


def _sh2(x: float | None) -> float | None:
    """A share in [0,1], 2 decimals."""
    return None if x is None else round(float(x), 2)


def _cv2(x: float | None) -> float | None:
    return None if x is None else round(float(x), 2)


def _i(x: Any) -> int:
    try:
        return int(x or 0)
    except Exception:
        return 0


# --------------------------------------------------------------------------- #
# META.json — the subway chain's own coverage report (all EIGHT position feeds)
# --------------------------------------------------------------------------- #
def _meta_sig() -> tuple:
    base = config.DERIVED_ROOT / _SUBWAY_DIR
    if not base.exists():
        return ()
    out = []
    for p in sorted(base.glob("date=*/META.json")):
        try:
            out.append((p.parent.name, int(p.stat().st_mtime)))
        except OSError:
            continue
    return tuple(out)


@lru_cache(maxsize=4)
def _meta_load(_sig: tuple) -> dict[str, Any]:
    """Per archive (UTC) day: per-feed poll coverage, the derivation's own stats, and the
    `not_derived` block it stamped into the artefact.

    `equivalent_complete_days_polls` is computed from the feed's OWN poll census
    (`polls_by_hour` / `expected_polls_per_hour`, capped at 1.0 per hour, summed, / 24).
    Polls are the honest observability measure for a transit feed: row counts track how
    many trains were running, so an overnight hour with a third of the rush-hour volume is
    fully observed, not partial. `subway_headways.py::_feed_coverage` uses the same rule.
    """
    base = config.DERIVED_ROOT / _SUBWAY_DIR
    days: dict[str, Any] = {}
    for p in sorted(base.glob("date=*/META.json")):
        day = p.parent.name.split("=", 1)[1]
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        feeds_out: dict[str, Any] = {}
        for feed, v in (j.get("feeds") or {}).items():
            if not isinstance(v, dict):
                continue
            expected = float(v.get("expected_polls_per_hour") or 0) or None
            polls = v.get("polls_by_hour") or {}
            eq = (sum(min(1.0, _i(c) / expected) for c in polls.values()) / 24.0
                  if expected else None)
            feeds_out[feed] = {
                "rows": _i(v.get("rows")),
                "stopped_at_rows": _i(v.get("stopped_at_rows")),
                "stopped_at_pct": v.get("stopped_at_pct"),
                "current_status_null_pct": v.get("current_status_null_pct"),
                "hours_present": _i(v.get("hours_present")),
                "hours_missing": v.get("hours_missing") or [],
                "hours_partial_lt60pct_polls": v.get("hours_partial_lt60pct_polls") or [],
                "hours_usable": _i(v.get("hours_usable")),
                "hours_usable_share": v.get("hours_usable_share"),
                "expected_polls_per_hour": _i(v.get("expected_polls_per_hour")),
                "equivalent_complete_days_polls": round(eq, 3) if eq is not None else None,
                "status": v.get("status"),
            }
        eqs = [f["equivalent_complete_days_polls"] for f in feeds_out.values()
               if f["equivalent_complete_days_polls"] is not None]
        days[day] = {
            "archive_day_utc": day,
            "generated_at": j.get("generated_at"),
            "archive_depth": j.get("archive_depth") or {},
            "feeds": feeds_out,
            "n_feeds": len(feeds_out),
            # the WORST feed governs: a headway needs both consecutive trains, and a train
            # missing from one feed is missing from the derivation full stop.
            "equivalent_complete_days_polls_min_feed": round(min(eqs), 3) if eqs else None,
            "equivalent_complete_days_polls_mean_feed": (
                round(sum(eqs) / len(eqs), 3) if eqs else None),
            "arrival_events_in_day": _i(j.get("arrival_events_in_day")),
            "headway_rows": _i(j.get("headway_rows")),
            "headway_stats": j.get("headway_stats") or {},
            "runtime_stats": j.get("runtime_stats") or {},
            "alert_exposure": j.get("alert_exposure") or {},
            "clock_rule": j.get("clock_rule") or {},
            "not_derived": j.get("not_derived") or {},
            "prospective_sinks": j.get("prospective_sinks") or {},
            "data_quality_exclude_hours": j.get("data_quality_exclude_hours") or {},
        }
    return days


def _meta() -> dict[str, Any]:
    return _meta_load(_meta_sig())


# --------------------------------------------------------------------------- #
# DATA_QUALITY.json — the `subway_gtfs` slice, on the SAME rule the bus side uses,
# so "subway is more/less complete than bus" is a comparison and not a slogan.
# --------------------------------------------------------------------------- #
def _dq_sig() -> tuple:
    base = config.DATA_QUALITY_ROOT
    if not base.exists():
        return ()
    out = []
    for p in sorted(base.glob("date=*/DATA_QUALITY.json")):
        try:
            out.append((p.parent.name, int(p.stat().st_mtime)))
        except OSError:
            continue
    return tuple(out)


@lru_cache(maxsize=4)
def _dq_load(_sig: tuple) -> dict[str, dict[str, Any]]:
    """Per archive day and per feed: equivalent-complete-day fraction + excluded hours.

    Identical arithmetic to `autostats.py::_dq_load` (each hour's coverage_pct capped at
    100, summed, / 24 / 100) so the subway and bus numbers are the same measurement.
    `exclude_from_stats_hours` is UTC in the source; local = (utc - 4) % 24.
    """
    base = config.DATA_QUALITY_ROOT
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(base.glob("date=*/DATA_QUALITY.json")):
        day = p.parent.name.split("=", 1)[1]
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        per_feed: dict[str, Any] = {}
        for feed, v in (j.get("feeds") or {}).items():
            if not isinstance(v, dict):
                continue
            hours = v.get("hours") or {}
            eq = sum(min(100.0, float(h.get("coverage_pct") or 0.0))
                     for h in hours.values()) / 100.0
            counts: dict[str, int] = {}
            for h in hours.values():
                s = str(h.get("status") or "unknown")
                counts[s] = counts.get(s, 0) + 1
            excl_utc = sorted(_i(h) for h in v.get("exclude_from_stats_hours", []))
            per_feed[feed] = {
                "equivalent_complete_hours": round(eq, 3),
                "equivalent_complete_days": round(eq / 24.0, 3),
                "complete": (eq / 24.0) >= COMPLETE_DAY_FRAC,
                "coverage_pct_mean": v.get("coverage_pct_mean"),
                "status_counts": counts,
                "excluded_utc_hours": excl_utc,
                "excluded_local_hours": sorted({(h - 4) % 24 for h in excl_utc}),
                "hours": {k: {"coverage_pct": vv.get("coverage_pct"),
                              "status": vv.get("status"), "rows": _i(vv.get("rows"))}
                          for k, vv in sorted(hours.items())},
            }
        out[day] = {
            "day": day,
            "generated_at": j.get("generated_at"),
            "feeds": per_feed,
            "known_gaps": j.get("known_gaps") or [],
        }
    return out


def _dq() -> dict[str, dict[str, Any]]:
    return _dq_load(_dq_sig())


# --------------------------------------------------------------------------- #
# the archive / coverage stamps every response carries
# --------------------------------------------------------------------------- #
def _archive_stamp() -> dict[str, Any]:
    """Depth as the DERIVATION recorded it, plus the local-date span actually in the cells.

    `archive_depth_days` and `preliminary` are the derivation's own columns/fields — this
    module does not re-derive them, it repeats them.
    """
    meta = _meta()
    days = sorted(meta)
    latest = meta[days[-1]]["archive_depth"] if days else {}
    return {
        "mode": "subway",
        "producer": "realtime/derive2/subway_headways.py",
        "archive_day_partitions": len(days),
        "archive_partition_first": days[0] if days else None,
        "archive_partition_last": days[-1] if days else None,
        "archive_depth_days": latest.get("archive_depth_days"),
        "archive_first_day": latest.get("first_day"),
        "archive_last_day": latest.get("last_day"),
        "preliminary": latest.get("preliminary"),
        "preliminary_note": (
            "PRELIMINARY means the subway archive is under 14 days deep. At this depth a "
            "number describes the days observed, not 'the subway'. No ordinal ranking of "
            "routes or stations is offered anywhere in this module."
        ),
        "arrival_method": "stopped_at_run",
        "arrival_method_note": (
            "An arrival is the FIRST poll of a contiguous STOPPED_AT run for a (trip, stop). "
            "Nothing is modelled or interpolated. Subway `current_status` is genuinely "
            "published, unlike the bus feed where it is 100% NULL."
        ),
    }


def _coverage_stamp() -> dict[str, Any]:
    meta = _meta()
    dq = _dq()
    days = sorted(meta)
    eq_polls = round(sum(meta[d]["equivalent_complete_days_polls_min_feed"] or 0.0
                         for d in days), 2)
    eq_dq = round(sum((v["feeds"].get(_DQ_FEED) or {}).get("equivalent_complete_days") or 0.0
                      for v in dq.values()), 2)
    eq_bus = round(sum((v["feeds"].get("bus_vehicle_positions") or {})
                       .get("equivalent_complete_days") or 0.0 for v in dq.values()), 2)
    complete = [d for d in sorted(dq)
                if (dq[d]["feeds"].get(_DQ_FEED) or {}).get("complete")]
    return {
        "archive_day_partitions": len(days),
        "equivalent_complete_days_subway": eq_dq,
        "equivalent_complete_days_subway_basis": (
            f"feed `{_DQ_FEED}` in derived/data_quality/date=*/DATA_QUALITY.json, on the "
            f"identical rule the bus side uses (each hour's coverage_pct capped at 100, "
            f"summed, / 24). This is the ONLY subway feed DATA_QUALITY.json tracks."
        ),
        "equivalent_complete_days_bus_same_rule": eq_bus,
        "equivalent_complete_days_all_eight_feeds_worst": round(
            sum(meta[d]["equivalent_complete_days_polls_min_feed"] or 0.0 for d in days), 2),
        "equivalent_complete_days_all_eight_feeds_basis": (
            "per-day WORST of the eight subway position feeds, from each feed's own poll "
            "census in subway_headways/date=*/META.json (polls per hour / expected polls "
            "per hour, capped at 1, summed, / 24). The worst feed governs because a headway "
            "needs both consecutive trains and a train missing from its feed is missing "
            "from the derivation."
        ),
        "equivalent_complete_days_polls_unused": eq_polls,
        "complete_days": len(complete),
        "complete_day_list": complete,
        "complete_day_rule": (
            f"a day counts as complete when its coverage-weighted hours reach "
            f"{COMPLETE_DAY_FRAC:.0%} of 24"
        ),
        "days_considered": days,
    }


# --------------------------------------------------------------------------- #
# The withheld-column verification. Counted on every cache miss so a producer
# regression that started POPULATING these columns shows up here loudly instead of
# being silently rendered as a delay number.
# --------------------------------------------------------------------------- #
def _withheld_check() -> dict[str, Any]:
    files = _cell_files()
    if not files:
        return {"checked": False, "reason": "no subway_headways partitions on disk"}
    sel = ", ".join(f"count({c}) AS nn_{c}" for c in WITHHELD_COLUMNS)
    con = _con()
    try:
        row = con.execute(f"SELECT count(*) AS total, {sel} FROM {_read(files)}").fetchone()
        bases = con.execute(
            f"SELECT sched_basis, bunching_basis, count(*) FROM {_read(files)} "
            f"GROUP BY 1, 2 ORDER BY 3 DESC"
        ).fetchall()
    finally:
        con.close()
    total = _i(row[0])
    non_null = {c: _i(v) for c, v in zip(WITHHELD_COLUMNS, row[1:])}
    leaked = {c: n for c, n in non_null.items() if n > 0}
    return {
        "checked": True,
        "checked_at": datetime.now(timezone.utc).isoformat(),
        "cells_total": total,
        "non_null_count_by_column": non_null,
        "all_columns_null": not leaked,
        "leaked_columns": leaked or None,
        "sched_basis_values": [{"sched_basis": b[0], "bunching_basis": b[1],
                                "cells": _i(b[2])} for b in bases],
        "rule": (
            "These seven columns exist so the subway cell grain matches the bus cell grain "
            "and a shared reader sees one schema. They are NULL by deliberate construction "
            "(subway_headways.py:485-493) and this API never renders them. If "
            "`all_columns_null` is ever false, the producer changed and the change must be "
            "reviewed before anything downstream displays it — this reader will still not "
            "render them."
        ),
    }


# --------------------------------------------------------------------------- #
# not_supported — name the metric, the real reason, and what would unblock it
# --------------------------------------------------------------------------- #
def _not_supported() -> list[dict[str, Any]]:
    return [
        {
            "metric": ("subway schedule deviation / adherence / 'on time' / "
                       "scheduled headway"),
            "status": "NOT DERIVED — WITHHELD AT SOURCE",
            "reason": (
                "The realtime subway trip_id (e.g. `041000_2..S05R`) does not join the "
                "GTFS-static subway trip_id (e.g. "
                "`ASP26GEN-1038-Sunday-00_000600_1..S03R`): 0 of 8,040 exact matches. A "
                "suffix join is possible but matched only 74.19% of trips / 80.76% of rows "
                "on 2026-07-23, with 1 ambiguous key of 8,415. A 74%-matched denominator "
                "is not a denominator, so `sched_median_headway_s`, `headway_deviation_s` "
                "and `median_deviation_s` are emitted as explicit NULLs on 100% of cells "
                "with sched_basis = 'not_joined_pending'."
            ),
            "columns_withheld": ["sched_median_headway_s", "headway_deviation_s",
                                 "median_deviation_s"],
            "unblocks_at": (
                "the suffix join proven over >= 7 days with the per-row match rate "
                "published beside every number it produces"
            ),
        },
        {
            "metric": "subway bunching / bunching index / bunched-gap share",
            "status": "NOT DERIVED — WITHHELD AT SOURCE",
            "reason": (
                "Bunching needs a scheduled-headway denominator, which does not exist (see "
                "above), so `bunch_share_lt50_sched` and `bunching_index` are NULL with "
                "bunching_basis = 'withheld_no_schedule_denominator'. "
                "`bunch_share_lt50_obs` — the share of gaps under half the OBSERVED median "
                "— needs no schedule and is arithmetically computable, but the derivation "
                "withholds it deliberately rather than ship a bunching-shaped number that "
                "readers would compare against the bus bunching figure, which IS "
                "schedule-based. This API does not compute it either."
            ),
            "columns_withheld": ["bunch_share_lt50_sched", "bunch_share_lt50_obs",
                                 "bunching_index"],
            "unblocks_at": (
                "a schedule denominator for the sched variants; an explicit product "
                "decision plus a distinct, non-comparable label for the observed variant"
            ),
        },
        {
            "metric": "GTFS direction_id (0/1) for subway",
            "status": "NOT CAPTURED",
            "reason": (
                "The feed's direction_id is 0 on 100% of rows including southbound ones — a "
                "proto2 default, not an agency value — so it is emitted NULL. The direction "
                "published here instead is the trailing N/S of the NYCT stop_id, which "
                "agrees with the trip_id's own direction character on 99.989% of rows where "
                "both are present."
            ),
            "columns_withheld": ["direction_id"],
            "unblocks_at": "MTA populating direction_id, or a proven nyct_direction backfill",
        },
        {
            "metric": "predicted vs realised arrival (subway)",
            "status": "PENDING — NO ARCHIVE DEPTH",
            "reason": (
                "The eight `subway_*_trip_updates` sinks began landing 2026-07-25T04:34:45Z "
                "— hours of history, not days — and population is uneven "
                "(`arrival_delay` is 97.6% on subway_l and 0% on subway_gtfs). Nothing in "
                "this module depends on them."
            ),
            "unblocks_at": ">= 7 days of trip-updates archive with per-feed population rates",
        },
        {
            "metric": "alert-severity-weighted subway service quality",
            "status": "PENDING — SEVERITY NOT PUBLISHED",
            "reason": (
                "The only severity signal MTA publishes is the Mercury `alert_type` "
                "taxonomy, which is absent from every archived row (`cause`/`effect` are "
                "proto2 defaults). Without it an unplanned suspension cannot be separated "
                "from a standing planned-work notice — which is why the alert-minutes union "
                "saturates at 60 for the trunk lines. `subway_alert_exposure` ships the "
                "measurement; this module does not turn it into a quality score."
            ),
            "unblocks_at": "the poller capturing the Mercury alert_type extension",
        },
        {
            "metric": "followable train trajectories / train_id-based statistics",
            "status": "NOT DERIVED — INSUFFICIENT COVERAGE",
            "reason": (
                "`train_id` began landing 2026-07-25 and carries a value on only ~7.8% of "
                "arrival events archive-wide (0% before that date). Subway `vehicle_id` is "
                "100% NULL. Nothing here is keyed on train identity."
            ),
            "unblocks_at": "train_id populated across a full archive window",
        },
        {
            "metric": "day-of-week / week-over-week / seasonal subway comparison",
            "status": "NOT BUILT",
            "reason": (
                "The subway archive begins 2026-07-17 and holds at most one observation of "
                "each weekday, one of which (2026-07-21) is ~87% missing to the disk-guard "
                "suspension. Any weekday effect is confounded 1:1 with the calendar date."
            ),
            "unblocks_at": ">= ~4 weeks of complete days",
        },
    ]


# --------------------------------------------------------------------------- #
# 1) index
# --------------------------------------------------------------------------- #
def _index_payload() -> dict[str, Any]:
    return {
        "service": "nycvisualizer subway stats",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "reads": {
            "cells": f"derived/{_SUBWAY_DIR}/date=*/part-000.parquet",
            "arrivals": f"derived/{_SUBWAY_DIR}/date=*/arrivals-000.parquet",
            "runs": f"derived/{_SUBWAY_DIR}/date=*/runs-000.parquet",
            "meta": f"derived/{_SUBWAY_DIR}/date=*/META.json",
            "data_quality": "derived/data_quality/date=*/DATA_QUALITY.json",
            "not_read_here": f"derived/{_ALERT_DIR}/date=*/part-000.parquet "
                             f"(alert exposure is a measurement, not a service statistic; "
                             f"no endpoint in this module renders it)",
        },
        "endpoints": [
            {"path": "/api/subwaystats/completeness",
             "what": "subway archive completeness: per-day, per-feed poll coverage from the "
                     "derivation's own META.json, the equivalent-complete-days number on the "
                     "same rule as the bus side, the not_derived reasons, and a live "
                     "re-verification that the withheld columns are still 100% NULL",
             "format": "json only (this is a report, not a table)"},
            {"path": "/api/subwaystats/profile",
             "what": "time-of-day OBSERVED-headway profile by local hour, pooled across days",
             "params": {"route": "subway route_id, e.g. A, 7, L (default: all)",
                        "station": "parent station id, e.g. 631 (default: all)",
                        "direction": "N | S — the NYCT stop_id suffix (default: both)",
                        "format": "json (default) | csv | xlsx | parquet | clipboard"}},
            {"path": "/api/subwaystats/routes",
             "what": "per-route rollup: stations, arrivals, cells, median observed headway, "
                     "headway CV, median dwell, hours observed. Routes weighted equally.",
             "params": {"format": "json (default) | csv | xlsx | parquet | clipboard"}},
            {"path": "/api/subwaystats/station/{station_id}",
             "what": "one parent station: identity, routes serving it, observed headway by "
                     "route and by local hour, dwell, arrival counts",
             "params": {"station_id": "parent station id (path)",
                        "format": "json (default) | csv | xlsx | parquet | clipboard"}},
            {"path": "/api/subwaystats/runs",
             "what": "observed origin-to-last-stop run times per route from runs-000.parquet, "
                     "honouring the derivation's terminal_to_terminal flag",
             "params": {"route": "subway route_id (default: all)",
                        "format": "json (default) | csv | xlsx | parquet | clipboard"}},
        ],
        "download_formats": {
            "supported": ["csv", "xlsx", "parquet", "clipboard"],
            "json": "the in-page response format only — a JSON *download* is deliberately "
                    "not offered anywhere in this estate",
            "provenance": "CSV carries provenance as leading `#` comment lines; XLSX carries "
                          "a Provenance sheet; Parquet carries a `nycvisualizer_provenance` "
                          "key-value in the file's own schema metadata.",
        },
        "direction_note": (
            "`direction` is the trailing N/S of the NYCT stop_id (a service direction, not a "
            "compass bearing). GTFS `direction_id` is NULL on 100% of subway cells."
        ),
        "not_supported": _not_supported(),
        "archive": _archive_stamp(),
        "coverage": _coverage_stamp(),
    }


@router.get("")
@router.get("/")
async def subwaystats_index() -> JSONResponse:
    return JSONResponse(_cached("index", CACHE_TTL_S, _index_payload))


# --------------------------------------------------------------------------- #
# 2) /completeness
# --------------------------------------------------------------------------- #
def _completeness_payload() -> dict[str, Any]:
    t0 = time.time()
    meta = _meta()
    dq = _dq()
    stamp = _coverage_stamp()
    days_out: list[dict[str, Any]] = []
    for day in sorted(meta):
        m = meta[day]
        d = (dq.get(day) or {}).get("feeds", {}).get(_DQ_FEED) or {}
        days_out.append({
            "archive_day_utc": day,
            "generated_at": m["generated_at"],
            "n_feeds_reported": m["n_feeds"],
            "equivalent_complete_days_subway_gtfs": d.get("equivalent_complete_days"),
            "complete": d.get("complete"),
            "status_counts_subway_gtfs": d.get("status_counts"),
            "excluded_utc_hours_subway_gtfs": d.get("excluded_utc_hours"),
            "excluded_local_hours_subway_gtfs": d.get("excluded_local_hours"),
            "equivalent_complete_days_worst_feed": m["equivalent_complete_days_polls_min_feed"],
            "equivalent_complete_days_mean_feed": m["equivalent_complete_days_polls_mean_feed"],
            "arrival_events_in_day": m["arrival_events_in_day"],
            "headway_cells_in_day": m["headway_rows"],
            "headway_stats": m["headway_stats"],
            "runtime_stats": m["runtime_stats"],
            "feeds": m["feeds"],
            "data_quality_exclude_hours": m["data_quality_exclude_hours"],
        })

    latest = meta[sorted(meta)[-1]] if meta else {}
    eq_sub = stamp["equivalent_complete_days_subway"]
    eq_bus = stamp["equivalent_complete_days_bus_same_rule"]
    cmp_word = ("more complete than" if eq_sub > eq_bus
                else "less complete than" if eq_sub < eq_bus else "as complete as")

    # The 2026-07-21 disk-guard suspension, checked against the evidence rather than
    # repeated from the plan.
    dg = "2026-07-21"
    dg_dq = (dq.get(dg) or {}).get("feeds", {})
    dg_sub = dg_dq.get(_DQ_FEED) or {}
    dg_bus = dg_dq.get("bus_vehicle_positions") or {}
    dg_meta = meta.get(dg) or {}
    disk_guard = {
        "day": dg,
        "present": bool(dg_meta),
        "subway_equivalent_complete_days": dg_sub.get("equivalent_complete_days"),
        "bus_equivalent_complete_days": dg_bus.get("equivalent_complete_days"),
        "subway_excluded_utc_hours": dg_sub.get("excluded_utc_hours"),
        "subway_feeds_with_missing_hours": sorted(
            f for f, v in (dg_meta.get("feeds") or {}).items() if v.get("hours_missing")),
        "verdict": (
            "The subway archive did NOT survive the 2026-07-21 disk-guard suspension "
            "intact. All eight subway position feeds lost the same hours (each retains only "
            f"hours 00 / 22 / 23) and the day is worth "
            f"{dg_sub.get('equivalent_complete_days')} equivalent complete days against a "
            f"possible 1.0. The suspension hit bus "
            f"({dg_bus.get('equivalent_complete_days')} equivalent days) and subway alike. "
            "What the subway chain does do correctly is FLAG it: `subway_known_gaps()` "
            "applies the window to all eight feeds, so every arrival inside it carries "
            "known_gap = true and every affected cell carries exclude_from_stats = true. "
            "The buffered rows were flushed into the hour=22 directory while carrying their "
            "true poll_ts across the whole day, so the partition reconstructs a full 24-hour "
            "day of arrivals that is real but incomplete — without the flag the missing "
            "trains would read as long headways."
        )
        if dg_meta else "no 2026-07-21 partition on disk",
    }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "subway",
        "headline": (
            f"{stamp['archive_day_partitions']} subway archive day-folders, worth "
            f"{eq_sub} equivalent complete days of subway data on the "
            f"`{_DQ_FEED}` feed — {cmp_word} the bus feed's {eq_bus} on the identical rule. "
            f"{stamp['complete_days']} day(s) are genuinely complete."
        ),
        "equivalent_complete_days": eq_sub,
        "equivalent_complete_days_method": stamp["equivalent_complete_days_subway_basis"],
        "equivalent_complete_days_bus_same_rule": eq_bus,
        "comparison_caveat": (
            "The subway number covers ONE of the eight subway position feeds — the only one "
            "DATA_QUALITY.json tracks. Measured instead on each feed's own poll census and "
            "taking the worst feed per day, the subway archive is worth "
            f"{stamp['equivalent_complete_days_all_eight_feeds_worst']} equivalent complete "
            "days. Both numbers are published; neither is a rounding of the other."
        ),
        "equivalent_complete_days_all_eight_feeds_worst":
            stamp["equivalent_complete_days_all_eight_feeds_worst"],
        "equivalent_complete_days_all_eight_feeds_method":
            stamp["equivalent_complete_days_all_eight_feeds_basis"],
        "complete_days": stamp["complete_days"],
        "complete_day_list": stamp["complete_day_list"],
        "complete_day_rule": stamp["complete_day_rule"],
        "feeds_derived_from": sorted(latest.get("feeds", {})),
        "usable_hours_rule": (
            "An hour is usable when the feed logged at least 60% of its expected polls "
            "(expected = 3600 / 30 s cadence = 120). Coverage is measured on DISTINCT POLLS, "
            "never on row counts: row counts track how many trains were running, so an "
            "overnight hour legitimately carries a third of the rush-hour volume and would "
            "otherwise be mislabelled partial."
        ),
        "status_vocabulary": {
            "ok": "hour present at >= 60% of the baseline for that feed x hour-of-day",
            "partial": "hour present but below 60% of baseline — EXCLUDED from every statistic",
            "missing": "hour absent with no declared cause — EXCLUDED",
            "known_gap": "hour inside a declared poller outage — EXCLUDED",
            "in_progress": "hour has not finished yet (today)",
        },
        "exclude_from_stats_note": (
            "Every cell in part-000.parquet carries `exclude_from_stats`, set true when the "
            "cell has any arrival inside a known poller gap OR any arrival in an hour below "
            "60% poll coverage. Every statistic in this module drops those cells."
        ),
        "days": days_out,
        "disk_guard_incident": disk_guard,
        "clock_rule": latest.get("clock_rule") or {},
        "not_derived_recorded_by_producer": latest.get("not_derived") or {},
        "prospective_sinks": latest.get("prospective_sinks") or {},
        "withheld_column_verification": _withheld_check(),
        "not_supported": _not_supported(),
        "archive": _archive_stamp(),
        "coverage": stamp,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/completeness")
async def subwaystats_completeness() -> JSONResponse:
    return JSONResponse(_cached("completeness", CACHE_TTL_S, _completeness_payload))


# --------------------------------------------------------------------------- #
# 3) /profile — time-of-day OBSERVED headway profile
# --------------------------------------------------------------------------- #
_PROFILE_NOTE = (
    "Within-day time-of-day profile of OBSERVED headways: every observed service day is "
    "pooled into 24 local-hour buckets, so each hour rests on several dates. It is "
    "explicitly NOT a weekday profile and explicitly NOT an adherence profile — there is no "
    "schedule in this dataset, so every number here answers 'how far apart were the trains "
    "we saw', never 'were they on time'."
)

_DWELL_NOTE = (
    "Dwell is measured on the POLL clock (the vehicle `timestamp` freezes during a "
    "STOPPED_AT run on several feeds and would read 0), so it is quantised to the 30 s poll "
    "cadence and is a LOWER BOUND: `dwell_lower_s` is the observed span of the run. When a "
    "run was caught by a single poll the dwell is interval-censored in (0, ~60 s] and the "
    "lower bound reads 0 — those zeros are INCLUDED in the median, so a station or route "
    "with a high `dwell_censored_share` will show a dwell that is too low. The share is "
    "published beside every dwell figure for exactly that reason."
)


def _profile_payload(route: str | None, station: str | None,
                     direction: str | None) -> dict[str, Any]:
    t0 = time.time()
    files = _cell_files()
    base: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "subway",
        "route": route,
        "station": station,
        "direction": direction,
        "grain": "local_hour",
        "note": _PROFILE_NOTE,
        "dwell_note": _DWELL_NOTE,
        "direction_note": (
            "`direction` is the trailing N/S of the NYCT stop_id — a service direction, not "
            "a compass bearing. GTFS direction_id is NULL on 100% of subway cells and this "
            "endpoint does not invent one."
        ),
        "statistic_note": (
            "Each published hour's headway is the MEDIAN OF THE CELL MEDIANS for that hour "
            "(a cell is route x direction x parent station x local date x local hour). "
            "Cells are weighted equally, so a 40-platform trunk hour is not dominated by one "
            "busy station. `n_headways` is the raw count of observed gaps behind the hour."
        ),
        "suppression": {
            "min_headways_per_cell": MIN_CELL_HEADWAYS,
            "min_headways_per_published_hour": MIN_HOUR_HEADWAYS,
            "min_cells_per_published_hour": MIN_HOUR_CELLS,
            "rule": (
                f"A cell enters the pool only with >= {MIN_CELL_HEADWAYS} observed gaps and "
                f"exclude_from_stats = false. An hour is PUBLISHED only with "
                f">= {MIN_HOUR_HEADWAYS} gaps from >= {MIN_HOUR_CELLS} cells; otherwise the "
                f"hour is returned with suppressed = true, null statistics and a stated "
                f"reason rather than a noisy number."
            ),
            "exclude_from_stats": (
                "cells flagged by the derivation (any arrival in a known poller gap, or in "
                "an hour below 60% poll coverage) are dropped before anything is computed"
            ),
        },
        "withheld_here": [c for c in WITHHELD_COLUMNS],
        "withheld_reason": (
            "no schedule denominator exists for the subway — see /api/subwaystats/ "
            "not_supported. No deviation, adherence or bunching figure is emitted."
        ),
        "archive": _archive_stamp(),
        "coverage": _coverage_stamp(),
    }
    if not files:
        return {**base, "hours": [], "no_data": True,
                "no_data_reason": "no subway_headways partitions on disk"}

    where = [f"n_headways >= {MIN_CELL_HEADWAYS}", "NOT exclude_from_stats"]
    params: list[Any] = []
    if route:
        where.append("route_id = ?")
        params.append(route)
    if station:
        where.append("station_id = ?")
        params.append(station)
    if direction:
        where.append("direction = ?")
        params.append(direction)

    con = _con()
    try:
        rows = con.execute(
            f"""
            SELECT local_hour,
                   sum(n_headways)                         AS n_headways,
                   count(*)                                AS n_cells,
                   count(DISTINCT local_date)              AS n_days,
                   count(DISTINCT route_id)                AS n_routes,
                   count(DISTINCT station_id)              AS n_stations,
                   sum(n_arrivals_total)                   AS n_arrivals,
                   median(median_headway_s)                AS med_hw,
                   median(mean_headway_s)                  AS mean_hw,
                   min(min_headway_s)                      AS min_hw,
                   max(max_headway_s)                      AS max_hw,
                   median(headway_cv)                      AS cv,
                   median(median_dwell_s)                  AS dwell,
                   avg(dwell_censored_share)               AS dwell_cens,
                   median(median_arr_uncertainty_s)        AS arr_unc,
                   min(min_hour_poll_coverage)             AS min_cov
            FROM {_read(files)}
            WHERE {' AND '.join(where)}
            GROUP BY 1 ORDER BY 1
            """,
            params,
        ).fetchall()
    finally:
        con.close()

    by_hour = {_i(r[0]): r for r in rows}
    hours: list[dict[str, Any]] = []
    n_pub = n_sup = 0
    for h in range(24):
        r = by_hour.get(h)
        if r is None:
            hours.append({
                "local_hour": h, "suppressed": True,
                "suppressed_reason": "no qualifying observations in this local hour",
                "n_headways": 0, "n_cells": 0, "n_days": 0, "n_arrivals": 0,
                "median_headway_min": None, "mean_headway_min": None,
                "min_headway_min": None, "max_headway_min": None,
                "headway_cv": None, "median_dwell_s": None,
                "dwell_censored_share": None, "median_arrival_uncertainty_s": None,
            })
            n_sup += 1
            continue
        nh, nc = _i(r[1]), _i(r[2])
        if nh < MIN_HOUR_HEADWAYS or nc < MIN_HOUR_CELLS:
            hours.append({
                "local_hour": h, "suppressed": True,
                "suppressed_reason": (
                    f"below the publish floor ({nh} gaps from {nc} cells; needs "
                    f">= {MIN_HOUR_HEADWAYS} gaps from >= {MIN_HOUR_CELLS} cells)"),
                "n_headways": nh, "n_cells": nc, "n_days": _i(r[3]),
                "n_arrivals": _i(r[6]),
                "median_headway_min": None, "mean_headway_min": None,
                "min_headway_min": None, "max_headway_min": None,
                "headway_cv": None, "median_dwell_s": None,
                "dwell_censored_share": None, "median_arrival_uncertainty_s": None,
            })
            n_sup += 1
            continue
        hours.append({
            "local_hour": h,
            "suppressed": False,
            "n_headways": nh,
            "n_cells": nc,
            "n_days": _i(r[3]),
            "n_routes": _i(r[4]),
            "n_stations": _i(r[5]),
            "n_arrivals": _i(r[6]),
            "median_headway_min": _min1(r[7]),
            "mean_headway_min": _min1(r[8]),
            "min_headway_min": _min1(r[9]),
            "max_headway_min": _min1(r[10]),
            "headway_cv": _cv2(r[11]),
            "median_dwell_s": _sec1(r[12]),
            "dwell_censored_share": _sh2(r[13]),
            "median_arrival_uncertainty_s": _sec1(r[14]),
            "min_hour_poll_coverage": _sh2(r[15]),
        })
        n_pub += 1

    pub = [h for h in hours if not h["suppressed"]]
    shortest = min(pub, key=lambda x: x["median_headway_min"] or 1e9, default=None)
    longest = max(pub, key=lambda x: x["median_headway_min"] or -1, default=None)
    return {
        **base,
        "hours": hours,
        "hours_published": n_pub,
        "hours_suppressed": n_sup,
        "n_headways_total": sum(h["n_headways"] for h in hours),
        "n_arrivals_total": sum(h.get("n_arrivals") or 0 for h in hours),
        "shortest_typical_gap_hour": (
            {"local_hour": shortest["local_hour"],
             "median_headway_min": shortest["median_headway_min"]} if shortest else None),
        "longest_typical_gap_hour": (
            {"local_hour": longest["local_hour"],
             "median_headway_min": longest["median_headway_min"]} if longest else None),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


def _profile_rows(p: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for h in p.get("hours") or []:
        out.append({
            "route_id": p.get("route"),
            "station_id": p.get("station"),
            "direction": p.get("direction"),
            "local_hour": h.get("local_hour"),
            "suppressed": h.get("suppressed"),
            "suppressed_reason": h.get("suppressed_reason"),
            "n_headways": h.get("n_headways"),
            "n_cells": h.get("n_cells"),
            "n_days": h.get("n_days"),
            "n_arrivals": h.get("n_arrivals"),
            "median_headway_min": h.get("median_headway_min"),
            "mean_headway_min": h.get("mean_headway_min"),
            "min_headway_min": h.get("min_headway_min"),
            "max_headway_min": h.get("max_headway_min"),
            "headway_cv": h.get("headway_cv"),
            "median_dwell_s": h.get("median_dwell_s"),
            "dwell_censored_share": h.get("dwell_censored_share"),
            "median_arrival_uncertainty_s": h.get("median_arrival_uncertainty_s"),
        })
    return out


def _profile_prov(p: dict[str, Any]) -> list[str]:
    return _prov_common(
        "NYC Visualizer — subway observed-headway time-of-day profile",
        [
            f"selection: route={p.get('route') or 'all'} · "
            f"station={p.get('station') or 'all'} · direction={p.get('direction') or 'both'}",
            f"method: {p.get('note')}",
            f"statistic: {p.get('statistic_note')}",
            f"suppression: {(p.get('suppression') or {}).get('rule')}",
            f"dwell: {p.get('dwell_note')}",
        ],
        p,
    )


@router.get("/profile")
async def subwaystats_profile(route: str | None = None, station: str | None = None,
                              direction: str | None = None, format: str = "json"):
    bad = _bad_format(format)
    if bad is not None:
        return bad
    if direction is not None:
        direction = direction.strip().upper()
        if direction not in ("N", "S", ""):
            return JSONResponse(
                {"error": f"unknown direction '{direction}'", "valid": ["N", "S"],
                 "reason": "the derivation's direction is the NYCT stop_id N/S suffix; "
                           "GTFS direction_id is NULL on 100% of subway cells"},
                status_code=400)
        direction = direction or None
    key = f"profile|{route}|{station}|{direction}"
    payload = _cached(key, CACHE_TTL_S, lambda: _profile_payload(route, station, direction))
    if format == "json":
        return JSONResponse(payload)
    return _export(_profile_rows(payload), _profile_prov(payload),
                   f"subway_profile_{route or 'all'}", format, sheet="Profile")


# --------------------------------------------------------------------------- #
# 4) /routes — per-route rollup, routes weighted equally
# --------------------------------------------------------------------------- #
_ROLLUP_STATISTIC = (
    "Each route number is the MEDIAN ACROSS THE LOCAL HOURS THAT ROUTE WAS ACTUALLY "
    "OBSERVED of that hour's median-of-cell-medians. Hours are built first (dropping "
    "excluded and thin cells), then the route is the median over its own observed hours. "
    "Routes are therefore weighted equally by hour, not by train volume: a route that only "
    "ran overnight is not compared against an all-day route on raw pooled gaps. "
    "`hours_observed` is published per route so the normalisation is auditable."
)


def _routes_payload() -> dict[str, Any]:
    t0 = time.time()
    cfiles = _cell_files()
    afiles = _arrival_files()
    base: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "subway",
        "rollup_statistic": _ROLLUP_STATISTIC,
        "dwell_note": _DWELL_NOTE,
        "direction_note": (
            "Both N and S directions are pooled into each route figure. Service is not "
            "symmetric; a per-direction figure is available from /profile with "
            "?route=<id>&direction=N|S."
        ),
        "suppression": {
            "min_headways_per_cell": MIN_CELL_HEADWAYS,
            "min_headways_per_route": MIN_ROUTE_HEADWAYS,
            "rule": (
                f"A route is PUBLISHED only with >= {MIN_ROUTE_HEADWAYS} observed gaps "
                f"across cells of >= {MIN_CELL_HEADWAYS} gaps each, after cells flagged "
                f"exclude_from_stats are dropped. Below that the route is returned with "
                f"suppressed = true, null statistics and its raw counts."
            ),
        },
        "withheld_here": list(WITHHELD_COLUMNS),
        "withheld_reason": (
            "no schedule denominator exists for the subway — no deviation, adherence or "
            "bunching column is computed or emitted"
        ),
        "archive": _archive_stamp(),
        "coverage": _coverage_stamp(),
    }
    if not cfiles:
        return {**base, "routes": [], "no_data": True,
                "no_data_reason": "no subway_headways partitions on disk"}

    con = _con()
    try:
        rows = con.execute(
            f"""
            WITH cells AS (
                SELECT * FROM {_read(cfiles)}
                WHERE n_headways >= {MIN_CELL_HEADWAYS} AND NOT exclude_from_stats
            ),
            per_hour AS (
                SELECT route_id, local_hour,
                       sum(n_headways)             AS nh,
                       sum(n_arrivals_total)       AS na,
                       count(*)                    AS ncells,
                       median(median_headway_s)    AS med,
                       median(headway_cv)          AS cv,
                       median(median_dwell_s)      AS dwell,
                       avg(dwell_censored_share)   AS dcens
                FROM cells GROUP BY 1, 2
            ),
            hourly AS (
                SELECT route_id,
                       count(*)      AS hours_observed,
                       sum(nh)       AS n_headways,
                       sum(na)       AS n_arrivals_cells,
                       sum(ncells)   AS n_cells,
                       median(med)   AS med_s,
                       median(cv)    AS cv,
                       median(dwell) AS dwell_s,
                       avg(dcens)    AS dwell_cens
                FROM per_hour GROUP BY 1
            ),
            -- identity comes from EVERY cell, filtered or not, so a route that exists in
            -- the archive but has no qualifying cell is still LISTED (suppressed with a
            -- stated reason) rather than silently vanishing from the rollup.
            ident AS (
                SELECT route_id,
                       count(DISTINCT station_id) AS n_stations,
                       count(DISTINCT local_date) AS n_days,
                       count(DISTINCT direction)  AS n_directions,
                       count(*)                   AS n_cells_all,
                       sum(n_headways)            AS n_headways_all,
                       sum(CASE WHEN exclude_from_stats THEN 1 ELSE 0 END) AS n_cells_excluded,
                       any_value(feed)            AS feed
                FROM {_read(cfiles)} GROUP BY 1
            )
            SELECT i.route_id, h.hours_observed, h.n_headways, h.n_arrivals_cells, h.n_cells,
                   h.med_s, h.cv, h.dwell_s, h.dwell_cens,
                   i.n_stations, i.n_days, i.n_directions, i.feed,
                   i.n_cells_all, i.n_headways_all, i.n_cells_excluded
            FROM ident i LEFT JOIN hourly h USING (route_id)
            ORDER BY i.route_id
            """
        ).fetchall()
        n_stations_total = _i(con.execute(
            f"SELECT count(DISTINCT station_id) FROM {_read(cfiles)}").fetchone()[0])
        arr = con.execute(
            f"""SELECT route_id, count(*) AS n, count(DISTINCT trip_id) AS ntrips
                FROM {_read(afiles)} WHERE NOT stale_arrival GROUP BY 1"""
        ).fetchall() if afiles else []
    finally:
        con.close()

    arr_by_route = {r[0]: (_i(r[1]), _i(r[2])) for r in arr}
    routes: list[dict[str, Any]] = []
    n_pub = n_sup = 0
    for r in rows:
        rid = r[0]
        nh = _i(r[2])
        n_arr, n_trips = arr_by_route.get(rid, (None, None))
        row: dict[str, Any] = {
            "route_id": rid,
            "n_stations": _i(r[9]),
            "n_directions": _i(r[11]),
            "n_days_observed": _i(r[10]),
            "hours_observed": _i(r[1]),
            "n_cells": _i(r[4]),
            "n_headways": nh,
            "n_arrival_events": n_arr,
            "n_arrival_events_note": (
                "every non-stale STOPPED_AT arrival event for this route in the archive, "
                "including arrivals that closed no headway"),
            "n_trips_observed": n_trips,
            "n_arrivals_in_published_cells": _i(r[3]),
            "feed": r[12],
            "n_cells_all_including_excluded": _i(r[13]),
            "n_headways_all_including_excluded": _i(r[14]),
            "n_cells_dropped_exclude_from_stats": _i(r[15]),
        }
        if nh < MIN_ROUTE_HEADWAYS:
            row.update({
                "suppressed": True,
                "suppressed_reason": (
                    f"below the publish floor ({nh} observed gaps in qualifying cells, from "
                    f"{_i(r[14])} in the archive across {_i(r[13])} cells of which "
                    f"{_i(r[15])} are flagged exclude_from_stats; needs "
                    f">= {MIN_ROUTE_HEADWAYS} after filtering)"),
                "median_headway_min": None, "headway_cv": None,
                "median_dwell_s": None, "dwell_censored_share": None,
            })
            n_sup += 1
        else:
            row.update({
                "suppressed": False,
                "median_headway_min": _min1(r[5]),
                "headway_cv": _cv2(r[6]),
                "median_dwell_s": _sec1(r[7]),
                "dwell_censored_share": _sh2(r[8]),
            })
            n_pub += 1
        routes.append(row)

    return {
        **base,
        "routes": routes,
        "n_routes": len(routes),
        "n_routes_published": n_pub,
        "n_routes_suppressed": n_sup,
        "totals": {
            "n_stations_distinct": n_stations_total,
            "n_headways": sum(r["n_headways"] for r in routes),
            "n_arrival_events": sum((r["n_arrival_events"] or 0) for r in routes),
            "note": ("n_stations_distinct is the distinct parent-station count across the "
                     "whole cell table. The per-route n_stations column does NOT sum to it: "
                     "a station served by four routes appears in four route rows. Adding "
                     "the route column would double-count every interchange."),
        },
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


def _routes_rows(p: dict[str, Any]) -> list[dict[str, Any]]:
    return [{k: v for k, v in r.items() if k != "n_arrival_events_note"}
            for r in (p.get("routes") or [])]


def _routes_prov(p: dict[str, Any]) -> list[str]:
    return _prov_common(
        "NYC Visualizer — subway per-route rollup",
        [
            f"rollup statistic: {p.get('rollup_statistic')}",
            f"suppression: {(p.get('suppression') or {}).get('rule')}",
            f"dwell: {p.get('dwell_note')}",
            f"directions: {p.get('direction_note')}",
        ],
        p,
    )


@router.get("/routes")
async def subwaystats_routes(format: str = "json"):
    bad = _bad_format(format)
    if bad is not None:
        return bad
    payload = _cached("routes", CACHE_TTL_S, _routes_payload)
    if format == "json":
        return JSONResponse(payload)
    return _export(_routes_rows(payload), _routes_prov(payload),
                   "subway_routes", format, sheet="Routes")


# --------------------------------------------------------------------------- #
# 5) /station/{station_id}
# --------------------------------------------------------------------------- #
def _station_payload(station_id: str) -> dict[str, Any]:
    t0 = time.time()
    cfiles = _cell_files()
    afiles = _arrival_files()
    base: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "subway",
        "station_id": station_id,
        "station_id_note": (
            "This is a GTFS PARENT station id. Platform-level child stop_ids (the parent id "
            "plus a trailing N or S) are folded into it; the suffix is kept as `direction`. "
            "Verified on this feed: for all 992 child stops, stop_id[:-1] == parent_station."
        ),
        "dwell_note": _DWELL_NOTE,
        "suppression": {
            "min_headways_per_cell": MIN_CELL_HEADWAYS,
            "min_headways_per_published_row": MIN_STATION_HEADWAYS,
            "rule": (
                f"A cell enters the pool with >= {MIN_CELL_HEADWAYS} observed gaps and "
                f"exclude_from_stats = false. A per-route or per-hour row is PUBLISHED only "
                f"with >= {MIN_STATION_HEADWAYS} gaps; otherwise it is returned with "
                f"suppressed = true and null statistics."
            ),
        },
        "withheld_here": list(WITHHELD_COLUMNS),
        "archive": _archive_stamp(),
        "coverage": _coverage_stamp(),
    }
    if not cfiles:
        return {**base, "found": False,
                "not_found_reason": "no subway_headways partitions on disk"}

    con = _con()
    try:
        ident = con.execute(
            f"""SELECT any_value(station_name)         AS name,
                       count(*)                        AS n_cells,
                       sum(n_headways)                 AS n_headways,
                       sum(n_arrivals_total)           AS n_arrivals_cells,
                       count(DISTINCT route_id)        AS n_routes,
                       count(DISTINCT local_date)      AS n_days,
                       count(DISTINCT direction)       AS n_directions,
                       list(DISTINCT feed)             AS feeds
                FROM {_read(cfiles)} WHERE station_id = ?""",
            [station_id],
        ).fetchone()
        if ident is None or _i(ident[1]) == 0:
            return {**base, "found": False,
                    "not_found_reason": (
                        f"station_id '{station_id}' produced no headway cells in the subway "
                        f"archive. It may be a CHILD platform id (try dropping the trailing "
                        f"N/S), a station with no observed consecutive arrivals, or absent "
                        f"from the archive window entirely.")}
        by_route = con.execute(
            f"""
            WITH cells AS (
                SELECT * FROM {_read(cfiles)}
                WHERE station_id = ? AND n_headways >= {MIN_CELL_HEADWAYS}
                  AND NOT exclude_from_stats
            )
            SELECT route_id, direction,
                   sum(n_headways)            AS nh,
                   sum(n_arrivals_total)      AS na,
                   count(*)                   AS ncells,
                   count(DISTINCT local_hour) AS nhours,
                   count(DISTINCT local_date) AS ndays,
                   median(median_headway_s)   AS med,
                   median(headway_cv)         AS cv,
                   median(median_dwell_s)     AS dwell,
                   avg(dwell_censored_share)  AS dcens
            FROM cells GROUP BY 1, 2 ORDER BY 1, 2
            """,
            [station_id],
        ).fetchall()
        by_hour = con.execute(
            f"""
            WITH cells AS (
                SELECT * FROM {_read(cfiles)}
                WHERE station_id = ? AND n_headways >= {MIN_CELL_HEADWAYS}
                  AND NOT exclude_from_stats
            )
            SELECT local_hour,
                   sum(n_headways)          AS nh,
                   sum(n_arrivals_total)    AS na,
                   count(*)                 AS ncells,
                   count(DISTINCT route_id) AS nroutes,
                   count(DISTINCT local_date) AS ndays,
                   median(median_headway_s) AS med,
                   median(headway_cv)       AS cv,
                   median(median_dwell_s)   AS dwell,
                   avg(dwell_censored_share) AS dcens
            FROM cells GROUP BY 1 ORDER BY 1
            """,
            [station_id],
        ).fetchall()
        arr = con.execute(
            f"""SELECT count(*)                                    AS n,
                       count(DISTINCT trip_id)                     AS ntrips,
                       count(DISTINCT route_id)                    AS nroutes,
                       sum(CASE WHEN stale_arrival THEN 1 ELSE 0 END)   AS nstale,
                       sum(CASE WHEN known_gap THEN 1 ELSE 0 END)       AS ngap,
                       sum(CASE WHEN dwell_censored THEN 1 ELSE 0 END)  AS ncens,
                       median(CASE WHEN NOT dwell_censored THEN dwell_lower_s END)
                                                                   AS dwell_unc,
                       any_value(parent_source)                    AS psrc,
                       min(local_date)                             AS d0,
                       max(local_date)                             AS d1
                FROM {_read(afiles)} WHERE station_id = ?""",
            [station_id],
        ).fetchone() if afiles else None
    finally:
        con.close()

    name = ident[0]
    routes_out: list[dict[str, Any]] = []
    for r in by_route:
        nh = _i(r[2])
        row: dict[str, Any] = {
            "route_id": r[0], "direction": r[1],
            "n_headways": nh, "n_arrivals_in_published_cells": _i(r[3]),
            "n_cells": _i(r[4]), "hours_observed": _i(r[5]), "n_days_observed": _i(r[6]),
        }
        if nh < MIN_STATION_HEADWAYS:
            row.update({"suppressed": True,
                        "suppressed_reason": (f"below the publish floor ({nh} observed gaps; "
                                              f"needs >= {MIN_STATION_HEADWAYS})"),
                        "median_headway_min": None, "headway_cv": None,
                        "median_dwell_s": None, "dwell_censored_share": None})
        else:
            row.update({"suppressed": False,
                        "median_headway_min": _min1(r[7]), "headway_cv": _cv2(r[8]),
                        "median_dwell_s": _sec1(r[9]), "dwell_censored_share": _sh2(r[10])})
        routes_out.append(row)

    hour_map = {_i(r[0]): r for r in by_hour}
    hours_out: list[dict[str, Any]] = []
    for h in range(24):
        r = hour_map.get(h)
        if r is None:
            hours_out.append({"local_hour": h, "suppressed": True,
                              "suppressed_reason": "no qualifying observations in this hour",
                              "n_headways": 0, "n_cells": 0,
                              "median_headway_min": None, "headway_cv": None,
                              "median_dwell_s": None, "dwell_censored_share": None})
            continue
        nh = _i(r[1])
        row = {"local_hour": h, "n_headways": nh,
               "n_arrivals_in_published_cells": _i(r[2]), "n_cells": _i(r[3]),
               "n_routes": _i(r[4]), "n_days_observed": _i(r[5])}
        if nh < MIN_STATION_HEADWAYS:
            row.update({"suppressed": True,
                        "suppressed_reason": (f"below the publish floor ({nh} observed gaps; "
                                              f"needs >= {MIN_STATION_HEADWAYS})"),
                        "median_headway_min": None, "headway_cv": None,
                        "median_dwell_s": None, "dwell_censored_share": None})
        else:
            row.update({"suppressed": False,
                        "median_headway_min": _min1(r[6]), "headway_cv": _cv2(r[7]),
                        "median_dwell_s": _sec1(r[8]), "dwell_censored_share": _sh2(r[9])})
        hours_out.append(row)

    arrivals_block: dict[str, Any]
    if arr is None:
        arrivals_block = {"available": False,
                          "reason": "no arrivals-000.parquet partitions on disk"}
    else:
        n = _i(arr[0])
        arrivals_block = {
            "available": True,
            "n_arrival_events": n,
            "n_trips_observed": _i(arr[1]),
            "n_routes_observed": _i(arr[2]),
            "n_stale_clock_excluded_from_headways": _i(arr[3]),
            "stale_clock_share": _sh2(_i(arr[3]) / n) if n else None,
            "n_in_known_poller_gap": _i(arr[4]),
            "n_dwell_censored": _i(arr[5]),
            "dwell_censored_share": _sh2(_i(arr[5]) / n) if n else None,
            "median_dwell_s_uncensored_only": _sec1(arr[6]),
            "median_dwell_s_uncensored_note": (
                "median of dwell_lower_s over runs caught by MORE than one poll — the "
                "censored zeros are excluded here, unlike the cell-level median_dwell_s, so "
                "the two dwell figures are different measurements and are labelled as such"),
            "parent_fold_source": arr[7],
            "parent_fold_source_note": (
                "gtfs_parent_station = the stop_id carried an explicit parent_station in "
                "stops.txt; suffix_rule = it did not and the trailing N/S was stripped "
                "instead (~0.5% of arrivals)"),
            "first_local_date": arr[8],
            "last_local_date": arr[9],
        }

    return {
        **base,
        "found": True,
        "station_name": name,
        "station_name_absent_reason": (
            None if name else
            "NOT CAPTURED — this station_id is absent from the GTFS static stops.txt this "
            "derivation folded against, so the derivation has no name for it. The id is "
            "still a valid observed parent station; only the label is missing."),
        "routes_serving": sorted({r[0] for r in by_route}),
        "directions_observed": sorted({r[1] for r in by_route if r[1]}),
        "feeds": sorted(ident[7] or []),
        "n_cells_total": _i(ident[1]),
        "n_headways_total": _i(ident[2]),
        "n_arrivals_in_cells_total": _i(ident[3]),
        "n_days_observed": _i(ident[5]),
        "by_route": routes_out,
        "by_local_hour": hours_out,
        "arrivals": arrivals_block,
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


def _station_rows(p: dict[str, Any]) -> list[dict[str, Any]]:
    sid, name = p.get("station_id"), p.get("station_name")
    out: list[dict[str, Any]] = []
    for r in p.get("by_route") or []:
        out.append({"station_id": sid, "station_name": name, "grain": "route_x_direction",
                    "route_id": r.get("route_id"), "direction": r.get("direction"),
                    "local_hour": None, **{k: v for k, v in r.items()
                                           if k not in ("route_id", "direction")}})
    for r in p.get("by_local_hour") or []:
        out.append({"station_id": sid, "station_name": name, "grain": "local_hour",
                    "route_id": None, "direction": None,
                    "local_hour": r.get("local_hour"),
                    **{k: v for k, v in r.items() if k != "local_hour"}})
    return out


def _station_prov(p: dict[str, Any]) -> list[str]:
    return _prov_common(
        "NYC Visualizer — subway station observed-headway detail",
        [
            f"station: {p.get('station_id')} {p.get('station_name') or '(name NOT CAPTURED)'}",
            f"routes serving: {', '.join(p.get('routes_serving') or []) or 'none observed'}",
            f"station id: {p.get('station_id_note')}",
            f"suppression: {(p.get('suppression') or {}).get('rule')}",
            f"dwell: {p.get('dwell_note')}",
            "two grains in one table: rows with grain=route_x_direction and rows with "
            "grain=local_hour. They are not additive — the same gaps appear in both.",
        ],
        p,
    )


@router.get("/station/{station_id}")
async def subwaystats_station(station_id: str, format: str = "json"):
    bad = _bad_format(format)
    if bad is not None:
        return bad
    payload = _cached(f"station|{station_id}", CACHE_TTL_S,
                      lambda: _station_payload(station_id))
    if format == "json":
        return JSONResponse(payload, status_code=200 if payload.get("found") else 404)
    if not payload.get("found"):
        return JSONResponse(payload, status_code=404)
    return _export(_station_rows(payload), _station_prov(payload),
                   f"subway_station_{station_id}", format, sheet="Station")


# --------------------------------------------------------------------------- #
# 6) /runs — observed origin-to-last-stop run times
# --------------------------------------------------------------------------- #
_RUN_DEFINITION = (
    "A run time is the elapsed time between a trip's FIRST observed arrival and its LAST "
    "observed arrival, and it is counted only when the derivation's `terminal_to_terminal` "
    "flag is true. That flag requires ALL of: the trip was seen at current_stop_seq <= 1 "
    "(saw_origin); the trip vanished from its feed at least 300 s before the end of the scan "
    "window, so it ended rather than being cut off (trip_finished_in_window); it was not "
    "clipped at the window start; and it has two distinct endpoints a non-zero time apart "
    "(n_stations >= 2, run_time_s > 0, origin_station != terminal_station). Everything else "
    "is in the file with the flag false and is not aggregated here."
)

_RUN_HONESTY = (
    "`terminal_station` is the LAST STATION WE OBSERVED the trip stopped at, not a station "
    "known to be the route's scheduled terminal — there is no schedule join, so nothing here "
    "can assert a scheduled terminal. Read this figure as 'origin to last observed stop', "
    "which for a trip that ran its full length is the end-to-end time and for a trip we lost "
    "sight of early is shorter. The n_stations column (a stop-sequence SPAN, not a count of "
    "observed stops) is published so the reader can see how much of the route each figure "
    "covers."
)


def _runs_payload(route: str | None) -> dict[str, Any]:
    t0 = time.time()
    files = _run_files()
    base: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "mode": "subway",
        "route": route,
        "definition": _RUN_DEFINITION,
        "honesty_note": _RUN_HONESTY,
        "shuttle_guard_note": (
            "The 42 St Shuttle (GS) is the reason the two-distinct-endpoints condition "
            "exists: its trips are usually caught at only one of its two stations at a 30 s "
            "cadence, and before the guard it reported a MEDIAN end-to-end time of 0.0 "
            "minutes over 2,120 rows. Zero minutes end to end is not a measurement. The "
            "`zero_length_flagged_runs` and `same_endpoint_flagged_runs` counters below "
            "re-verify on every refresh that no zero-length or single-station run carries "
            "the flag."
        ),
        "suppression": {
            "min_qualifying_runs_per_route": MIN_RUNS,
            "rule": (
                f"A route publishes a run time only with >= {MIN_RUNS} qualifying runs. "
                f"Below that it is returned with suppressed = true, null statistics and its "
                f"raw counts. METHODS_derive2.md §9.6 records routes 1/2/3 holding only "
                f"60/29/46 qualifying runs each at this depth — they are deliberately not "
                f"reported rather than reported thinly."
            ),
        },
        "archive": _archive_stamp(),
        "coverage": _coverage_stamp(),
    }
    if not files:
        return {**base, "routes": [], "no_data": True,
                "no_data_reason": "no runs-000.parquet partitions on disk"}

    where = ["TRUE"]
    params: list[Any] = []
    if route:
        where.append("route_id = ?")
        params.append(route)

    con = _con()
    try:
        rows = con.execute(
            f"""
            SELECT route_id,
                   count(*)                                              AS n_rows,
                   sum(CASE WHEN terminal_to_terminal THEN 1 ELSE 0 END) AS n_tt,
                   sum(CASE WHEN saw_origin THEN 1 ELSE 0 END)           AS n_saw_origin,
                   sum(CASE WHEN clipped_at_window_start THEN 1 ELSE 0 END) AS n_clipped,
                   median(CASE WHEN terminal_to_terminal THEN run_time_s END)  AS med,
                   quantile_cont(CASE WHEN terminal_to_terminal THEN run_time_s END, 0.25)
                                                                         AS p25,
                   quantile_cont(CASE WHEN terminal_to_terminal THEN run_time_s END, 0.75)
                                                                         AS p75,
                   min(CASE WHEN terminal_to_terminal THEN run_time_s END)     AS mn,
                   max(CASE WHEN terminal_to_terminal THEN run_time_s END)     AS mx,
                   median(CASE WHEN terminal_to_terminal THEN total_dwell_s END) AS dwell,
                   median(CASE WHEN terminal_to_terminal THEN n_stations END)  AS nst,
                   median(CASE WHEN terminal_to_terminal THEN n_arrivals END)  AS narr,
                   count(DISTINCT CASE WHEN terminal_to_terminal THEN trip_id END) AS ntrips,
                   count(DISTINCT CASE WHEN terminal_to_terminal THEN local_date END) AS ndays,
                   count(DISTINCT CASE WHEN terminal_to_terminal THEN direction END) AS ndirs
            FROM {_read(files)}
            WHERE {' AND '.join(where)}
            GROUP BY 1 ORDER BY 1
            """,
            params,
        ).fetchall()
        guard = con.execute(
            f"""SELECT sum(CASE WHEN terminal_to_terminal AND run_time_s <= 0
                                THEN 1 ELSE 0 END),
                       sum(CASE WHEN terminal_to_terminal
                                 AND origin_station = terminal_station THEN 1 ELSE 0 END),
                       sum(CASE WHEN terminal_to_terminal AND n_stations < 2
                                THEN 1 ELSE 0 END),
                       sum(CASE WHEN terminal_to_terminal THEN 1 ELSE 0 END),
                       count(*)
                FROM {_read(files)}"""
        ).fetchone()
    finally:
        con.close()

    routes_out: list[dict[str, Any]] = []
    n_pub = n_sup = 0
    for r in rows:
        n_tt = _i(r[2])
        row: dict[str, Any] = {
            "route_id": r[0],
            "n_trips_in_file": _i(r[1]),
            "n_qualifying_runs": n_tt,
            "qualifying_share": _sh2(n_tt / _i(r[1])) if _i(r[1]) else None,
            "n_saw_origin": _i(r[3]),
            "n_clipped_at_window_start": _i(r[4]),
            "n_distinct_trips": _i(r[13]),
            "n_days_observed": _i(r[14]),
            "n_directions": _i(r[15]),
        }
        if n_tt < MIN_RUNS:
            row.update({
                "suppressed": True,
                "suppressed_reason": (
                    f"below the publish floor ({n_tt} qualifying run(s); needs "
                    f">= {MIN_RUNS})"),
                "median_run_time_min": None, "p25_run_time_min": None,
                "p75_run_time_min": None, "min_run_time_min": None,
                "max_run_time_min": None, "median_dwell_total_min": None,
                "median_stop_sequence_span": None, "median_arrivals_observed": None,
            })
            n_sup += 1
        else:
            row.update({
                "suppressed": False,
                "median_run_time_min": _min1(r[5]),
                "p25_run_time_min": _min1(r[6]),
                "p75_run_time_min": _min1(r[7]),
                "min_run_time_min": _min1(r[8]),
                "max_run_time_min": _min1(r[9]),
                "median_dwell_total_min": _min1(r[10]),
                "median_stop_sequence_span": (round(float(r[11]), 1)
                                              if r[11] is not None else None),
                "median_arrivals_observed": (round(float(r[12]), 1)
                                             if r[12] is not None else None),
            })
            n_pub += 1
        routes_out.append(row)

    return {
        **base,
        "routes": routes_out,
        "n_routes": len(routes_out),
        "n_routes_published": n_pub,
        "n_routes_suppressed": n_sup,
        "guard_verification": {
            "zero_length_flagged_runs": _i(guard[0]),
            "same_endpoint_flagged_runs": _i(guard[1]),
            "single_station_flagged_runs": _i(guard[2]),
            "flagged_runs_total": _i(guard[3]),
            "rows_total": _i(guard[4]),
            "guard_holds": (_i(guard[0]) == 0 and _i(guard[1]) == 0 and _i(guard[2]) == 0),
            "rule": ("the derivation's two-distinct-endpoints guard is re-checked here on "
                     "every refresh; all three counters must be 0"),
        },
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


def _runs_rows(p: dict[str, Any]) -> list[dict[str, Any]]:
    return list(p.get("routes") or [])


def _runs_prov(p: dict[str, Any]) -> list[str]:
    return _prov_common(
        "NYC Visualizer — subway observed origin-to-last-stop run times",
        [
            f"selection: route={p.get('route') or 'all'}",
            f"definition: {p.get('definition')}",
            f"what this is NOT: {p.get('honesty_note')}",
            f"suppression: {(p.get('suppression') or {}).get('rule')}",
            f"shuttle guard: {p.get('shuttle_guard_note')}",
        ],
        p,
    )


@router.get("/runs")
async def subwaystats_runs(route: str | None = None, format: str = "json"):
    bad = _bad_format(format)
    if bad is not None:
        return bad
    payload = _cached(f"runs|{route}", CACHE_TTL_S, lambda: _runs_payload(route))
    if format == "json":
        return JSONResponse(payload)
    return _export(_runs_rows(payload), _runs_prov(payload),
                   f"subway_runs_{route or 'all'}", format, sheet="RunTimes")


# --------------------------------------------------------------------------- #
# Export writer — mirrors site/backend/app/stops.py::stops_export.
# CSV carries provenance as leading `#` comments; XLSX carries a Provenance sheet;
# Parquet carries `nycvisualizer_provenance` in the file's own schema metadata.
# There is NO JSON download: json is the in-page response, not an attachment.
# --------------------------------------------------------------------------- #
_FORMATS = ("json", "csv", "xlsx", "parquet", "clipboard")


def _bad_format(fmt: str) -> JSONResponse | None:
    if fmt in _FORMATS:
        return None
    return JSONResponse(
        {"error": f"unknown format '{fmt}'",
         "supported": list(_FORMATS),
         "reason": "a JSON *download* is deliberately not offered — json is the in-page "
                   "response format, and every download carries its own provenance"},
        status_code=400)


def _prov_common(title: str, lines: list[str], payload: dict[str, Any]) -> list[str]:
    arch = payload.get("archive") or {}
    cov = payload.get("coverage") or {}
    out = [
        title,
        f"generated {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}",
        "source: our own subway GTFS-realtime archive, derived by "
        "realtime/derive2/subway_headways.py from observed STOPPED_AT events. "
        "No schedule, no model, no interpolation.",
        f"archive depth: {arch.get('archive_depth_days')} day(s) "
        f"({arch.get('archive_first_day')} to {arch.get('archive_last_day')}), worth "
        f"{cov.get('equivalent_complete_days_subway')} equivalent complete days"
        + (" — PRELIMINARY (under 14 days)" if arch.get("preliminary") else ""),
    ]
    out += [ln for ln in lines if ln]
    out += [
        "NO SUBWAY DELAY, ON-TIME, SCHEDULE-DEVIATION, ADHERENCE OR BUNCHING FIGURE APPEARS "
        "IN THIS FILE. The realtime subway trip_id does not join the GTFS static trip_id "
        "(0 of 8,040 exact matches; a suffix join reaches only 74% of trips), so there is no "
        "scheduled-headway denominator and none is guessed. Every gap here is an OBSERVED "
        "gap between two trains we watched arrive.",
        "direction is the trailing N/S of the NYCT stop_id (a service direction, not a "
        "compass bearing). GTFS direction_id is NULL on 100% of subway cells.",
        "blank cells are NOT zero. A blank statistic beside a `suppressed_reason` means the "
        "row was below the stated publish floor; the counts beside it are still real.",
    ]
    return out


def _export(rows: list[dict[str, Any]], prov: list[str], name: str,
            fmt: str, sheet: str = "Data") -> Response:
    stamp = time.strftime("%Y%m%d_%H%M", time.gmtime())
    fname = f"{name}_{stamp}"
    cols = list(rows[0].keys()) if rows else []

    if fmt == "clipboard":
        # Tab-separated: what pastes cleanly into a spreadsheet or an email.
        lines = ["# " + p for p in prov]
        if rows:
            lines.append("\t".join(cols))
            for r in rows:
                lines.append("\t".join("" if r.get(c) is None else str(r.get(c))
                                       for c in cols))
        return Response("\n".join(lines), media_type="text/plain; charset=utf-8")

    if fmt == "csv":
        buf = io.StringIO()
        for line in prov:
            buf.write("# " + line.replace("\n", " ") + "\n")
        if rows:
            w = csv.DictWriter(buf, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({k: ("" if r.get(k) is None else r.get(k)) for k in cols})
        return Response(buf.getvalue().encode("utf-8"), media_type="text/csv;charset=utf-8",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{fname}.csv"'})

    import pandas as pd

    if fmt == "parquet":
        import pyarrow as pa
        import pyarrow.parquet as pq

        tbl = pa.Table.from_pandas(pd.DataFrame(rows), preserve_index=False)
        # Provenance rides in the file's own key-value metadata so it survives the file
        # being moved, renamed and reopened months later.
        md = dict(tbl.schema.metadata or {})
        md[b"nycvisualizer_provenance"] = "\n".join(prov).encode("utf-8")
        b = io.BytesIO()
        pq.write_table(tbl.replace_schema_metadata(md), b, compression="snappy")
        return Response(b.getvalue(), media_type="application/vnd.apache.parquet",
                        headers={"Content-Disposition":
                                 f'attachment; filename="{fname}.parquet"'})

    # xlsx — the one format where the caveats can travel beside the numbers.
    b = io.BytesIO()
    with pd.ExcelWriter(b, engine="xlsxwriter") as xl:
        pd.DataFrame(rows).to_excel(xl, sheet_name=sheet[:31], index=False)
        pd.DataFrame({"About this file": prov}).to_excel(
            xl, sheet_name="Provenance", index=False)
    return Response(
        b.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}.xlsx"'})


# --------------------------------------------------------------------------- #
# Local smoke test: `python -m app.subway_stats` from site/backend, or run this file
# with the backend on sys.path. Prints the headline numbers of every payload.
# --------------------------------------------------------------------------- #
def _smoke() -> None:  # pragma: no cover - developer convenience
    def head(label: str, obj: Any) -> None:
        print(f"--- {label} " + "-" * max(0, 60 - len(label)))
        print(json.dumps(obj, indent=1, default=str)[:2000])

    head("archive", _archive_stamp())
    head("coverage", _coverage_stamp())
    head("withheld", _withheld_check())
    c = _completeness_payload()
    head("completeness.headline", {"headline": c["headline"],
                                   "disk_guard": c["disk_guard_incident"]})
    p = _profile_payload("7", None, None)
    head("profile(7)", {"published": p["hours_published"], "hours": p["hours"][7:10]})
    r = _routes_payload()
    head("routes", {"n": r["n_routes"], "sample": r["routes"][:2]})
    s = _station_payload("631")
    head("station 631", {"name": s.get("station_name"),
                         "routes": s.get("routes_serving"),
                         "by_route": (s.get("by_route") or [])[:2]})
    u = _runs_payload(None)
    head("runs", {"published": u["n_routes_published"], "guard": u["guard_verification"],
                  "sample": u["routes"][:2]})


if __name__ == "__main__":  # pragma: no cover
    _smoke()
