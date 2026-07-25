"""Auto-stats (W6b P4) — derived, plain-language bus statistics for non-technical readers.

A self-contained `APIRouter` (`/api/autostats/*`) mounted by main.py with a single include
line. NOTHING here lives in obs.py; obs.py is imported for exactly one symbol
(`_archive_meta`) so the archive-honesty contract has a single owner.

Endpoints
---------
  GET /api/autostats/completeness              archive-completeness banner (the honest depth)
  GET /api/autostats/route/{route_id}/today     "your route today" + a stated-rule verdict
  GET /api/autostats/profile                    time-of-day reliability profile (FLAGSHIP)
  GET /api/autostats/boroughs                   borough rollups (route-ID-prefix boroughs)
  GET /api/autostats/route/{route_id}/slowspots corridor slow-spots (where service degrades)
  GET /api/autostats/ladder                     THE ROUTE LADDER — stops + live buses interleaved

Reads
-----
  * derive2 observed headways   DERIVED_ROOT/observed_headways/date=*/part-000.parquet
  * derive2 data quality        DERIVED_ROOT/data_quality/date=*/DATA_QUALITY.json
  * derive2 speed table         DERIVED_ROOT/route_segment_speeds/{segment,route}-000.parquet
  * derive2 GTFS cache          DERIVE2_CACHE/{trip_meta,stop_offsets,stops}.parquet
  * bus analysis outputs        BUS_OUTPUTS_DIR/{02_all_segments_peak,02_segment_geometry}.parquet
  * live vehicles               app.realtime.get_vehicles()  (already motion-enriched)
  * canonical shapes            app.busshapes.get_lut()      (the offset space vehicles use)

WHAT IS DELIBERATELY NOT BUILT (see `not_supported` in /completeness)
--------------------------------------------------------------------
Day-of-week comparison, week-over-week and seasonal comparison. The archive holds ONE
observation per weekday and the single Tuesday is ~82% missing, so any weekday effect is
confounded 1:1 with date. A metric that cannot be defended does not ship.

Time base
---------
NYC is EDT (UTC-4) for the whole archive window. Local seconds = utc + NYC_UTC_OFFSET_S.
A LOCAL service day D straddles TWO archive partitions: local hours 00-19 land in
`date=D`, local hours 20-23 land in `date=D+1`. Every query here reads both and filters on
the `local_date` COLUMN — reading only `date=D` silently drops the 20:00-23:59 evening.
"""
from __future__ import annotations

import bisect
import calendar as _cal
import json
import os
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Any

import duckdb
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import busshapes, config, gtfs, realtime
from .obs import _archive_meta  # single owner of the archive-honesty contract

router = APIRouter(prefix="/api/autostats", tags=["autostats"])


# --------------------------------------------------------------------------- #
# Tunables. Read from os.environ HERE (config.py is owned elsewhere); every
# default is documented and every threshold is echoed in the response so a
# reader can see the rule that produced the number.
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


# --- suppression (publish nothing below these; say so rather than publish noise) ---
MIN_CELL_HEADWAYS = _envi("NYCV_AS_MIN_CELL_HEADWAYS", 5)     # per stop x hour x day cell
MIN_HOUR_HEADWAYS = _envi("NYCV_AS_MIN_HOUR_HEADWAYS", 20)    # per published hour row
MIN_HOUR_CELLS = _envi("NYCV_AS_MIN_HOUR_CELLS", 3)           # distinct cells behind an hour
MIN_TODAY_HEADWAYS = _envi("NYCV_AS_MIN_TODAY_HEADWAYS", 30)  # before any verdict is issued
MIN_ROUTE_HEADWAYS = _envi("NYCV_AS_MIN_ROUTE_HEADWAYS", 50)  # before a route joins a rollup
MIN_SEG_OBS = _envi("NYCV_AS_MIN_SEG_OBS", 200)               # per half-mile speed bin

# --- verdict thresholds (the stated rule) ---
V_BUNCH = _envf("NYCV_AS_V_BUNCH", 0.25)        # share of gaps < half the scheduled gap
V_LONG = _envf("NYCV_AS_V_LONG", 1.25)          # observed / scheduled typical gap
V_SHORT = _envf("NYCV_AS_V_SHORT", 0.80)
V_CV = _envf("NYCV_AS_V_CV", 0.60)              # gap-to-gap coefficient of variation

# --- day completeness ---
COMPLETE_DAY_FRAC = _envf("NYCV_AS_COMPLETE_DAY_FRAC", 0.85)  # eq-hours/24 to call a day complete

# --- route ladder / presentable distance (MTA Bus Time vocabulary, §4.1) ---
AT_STOP_FT = _envf("NYCV_AS_AT_STOP_FT", 100.0)
APPROACHING_FT = _envf("NYCV_AS_APPROACHING_FT", 500.0)
MAX_STOP_COUNT = _envi("NYCV_AS_MAX_STOP_COUNT", 2)   # beyond this, DEGRADE to miles
BUNCH_GAP_FT = _envf("NYCV_AS_BUNCH_GAP_FT", 1000.0)  # two buses this close = a bunched pair

_HW_DIR = "observed_headways"


# --------------------------------------------------------------------------- #
# time helpers (fixed EDT offset — no DST transition inside the archive window)
# --------------------------------------------------------------------------- #
def _local_now() -> datetime:
    return datetime.fromtimestamp(time.time() + config.NYC_UTC_OFFSET_S, tz=timezone.utc)


def _today_local() -> str:
    return _local_now().date().isoformat()


def _next_day(date_str: str) -> str:
    return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=1)).date().isoformat()


def _local_midnight_utc(date_str: str) -> int:
    y, m, d = (int(x) for x in date_str.split("-"))
    return _cal.timegm((y, m, d, 0, 0, 0, 0, 0, 0)) - config.NYC_UTC_OFFSET_S


# --------------------------------------------------------------------------- #
# DuckDB plumbing — fresh in-memory connection, explicit file lists, no jane_geo
# --------------------------------------------------------------------------- #
def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    return con


def _q(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def _plist(paths: list[str]) -> str:
    return "[" + ",".join(_q(p) for p in paths) + "]"


def _cache_file(name: str) -> str:
    return (config.DERIVE2_CACHE / f"{name}.parquet").as_posix()


def _bus_file(name: str) -> str:
    return (config.BUS_OUTPUTS_DIR / f"{name}.parquet").as_posix()


def _partition_dates() -> list[str]:
    base = config.DERIVED_ROOT / _HW_DIR
    if not base.exists():
        return []
    return sorted(
        p.name.split("=", 1)[1] for p in base.glob("date=*")
        if (p / "part-000.parquet").exists()
    )


def _hw_files(partition_dates: list[str]) -> list[str]:
    base = config.DERIVED_ROOT / _HW_DIR
    out = []
    for d in partition_dates:
        f = base / f"date={d}" / "part-000.parquet"
        if f.exists():
            out.append(f.as_posix())
    return out


def _files_for_local_dates(local_dates: list[str]) -> list[str]:
    """A LOCAL day D lives in archive partitions D (hours 00-19) and D+1 (hours 20-23)."""
    want: set[str] = set()
    for d in local_dates:
        want.add(d)
        want.add(_next_day(d))
    return _hw_files(sorted(want))


# --------------------------------------------------------------------------- #
# tiny TTL cache (same pattern as obs.py)
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
# DATA_QUALITY — the honest depth, and the hours every stat must drop
# --------------------------------------------------------------------------- #
_DQ_FEED = "bus_vehicle_positions"


def _dq_sig() -> tuple:
    base = config.DERIVED_ROOT / "data_quality"
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
def _dq_load(_sig: tuple) -> dict[str, Any]:
    """Per archive DAY: hourly status, the local hours to exclude, and equivalent-complete-day
    fractions. `exclude_from_stats_hours` is UTC in the source; local = (utc - 4) % 24, exactly
    as derive2/package_headways.py::_excluded_hours does it."""
    base = config.DERIVED_ROOT / "data_quality"
    days: dict[str, Any] = {}
    for p in sorted(base.glob("date=*/DATA_QUALITY.json")):
        day = p.parent.name.split("=", 1)[1]
        try:
            j = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        feed = (j.get("feeds") or {}).get(_DQ_FEED) or {}
        hours = feed.get("hours") or {}
        excl_utc = [int(h) for h in feed.get("exclude_from_stats_hours", [])]
        eq_hours = sum(min(100.0, float(h.get("coverage_pct") or 0.0)) for h in hours.values()) / 100.0
        status_counts: dict[str, int] = {}
        for h in hours.values():
            s = str(h.get("status") or "unknown")
            status_counts[s] = status_counts.get(s, 0) + 1
        days[day] = {
            "day": day,
            "generated_at": j.get("generated_at"),
            "hours": {
                k: {"rows": int(v.get("rows") or 0),
                    "coverage_pct": v.get("coverage_pct"),
                    "status": v.get("status")}
                for k, v in sorted(hours.items())
            },
            "status_counts": status_counts,
            "coverage_pct_mean": feed.get("coverage_pct_mean"),
            "excluded_utc_hours": sorted(excl_utc),
            "excluded_local_hours": sorted({(h - 4) % 24 for h in excl_utc}),
            "equivalent_complete_hours": round(eq_hours, 3),
            "equivalent_complete_days": round(eq_hours / 24.0, 3),
            "complete": (eq_hours / 24.0) >= COMPLETE_DAY_FRAC,
            "known_gaps": j.get("known_gaps") or [],
            "partial_hours": j.get("partial_hours") or [],
            "missing_hours": j.get("missing_hours") or [],
        }
    return days


def _dq() -> dict[str, Any]:
    return _dq_load(_dq_sig())


def _dq_exclusion_sql(alias: str = "") -> str:
    """SQL predicate dropping every (archive partition day, LOCAL hour) flagged partial/gap.

    The partition day arrives as the hive column `date`; the local hour is the `local_hour`
    column. Applied per PARTITION (not per local_date) so it matches derive2's own filter.
    """
    a = f"{alias}." if alias else ""
    clauses = []
    for day, info in _dq().items():
        hrs = info["excluded_local_hours"]
        if not hrs:
            continue
        hlist = ",".join(str(h) for h in hrs)
        clauses.append(f"NOT ({a}date = DATE {_q(day)} AND {a}local_hour IN ({hlist}))")
    return " AND ".join(clauses) if clauses else "TRUE"


def _coverage_stamp(local_dates: list[str] | None = None) -> dict[str, Any]:
    """The compact coverage stamp every endpoint carries."""
    dq = _dq()
    days = sorted(dq)
    sel = [d for d in days if (local_dates is None or d in local_dates)]
    eq = round(sum(dq[d]["equivalent_complete_days"] for d in sel), 3)
    complete = [d for d in sel if dq[d]["complete"]]
    return {
        "archive_day_directories": len(days),
        "equivalent_complete_days": eq,
        "complete_days": len(complete),
        "complete_day_list": complete,
        "complete_day_rule": (
            f"a day counts as complete when its coverage-weighted hours reach "
            f"{COMPLETE_DAY_FRAC:.0%} of 24"
        ),
        "days_considered": sel,
        "excluded_local_hours_by_day": {
            d: dq[d]["excluded_local_hours"] for d in sel if dq[d]["excluded_local_hours"]
        },
        "depth_note": (
            "Counting directories overstates the archive. The honest depth is the "
            "coverage-weighted equivalent-complete-days number above. Day-of-week, "
            "week-over-week and seasonal comparisons are NOT derivable at this depth and "
            "are not published anywhere in this API."
        ),
    }


# --------------------------------------------------------------------------- #
# Borough from the ROUTE-ID PREFIX (never from the owning GTFS feed directory)
# --------------------------------------------------------------------------- #
_BOROUGH_NAME = {
    "Bx": "Bronx",
    "B": "Brooklyn",
    "M": "Manhattan",
    "Q": "Queens",
    "S": "Staten Island",
    "SIM": "Staten Island express (SIM)",
    "X": "Express (X)",
}
_BOROUGH_ORDER = ["Bx", "B", "M", "Q", "S", "SIM", "X"]

_BOROUGH_NOTE = (
    "A route is grouped by its HOME borough, parsed from the route-ID prefix "
    "(BX->Bx, SIM->SIM, X->X, otherwise the leading M/B/Q/S). The grouping applies to the "
    "WHOLE route along its whole length — there is no per-segment borough logic, so a route "
    "that crosses a bridge is still counted once, under its home borough. This deliberately "
    "does NOT use the backend's feed-directory borough field, which files 92 routes under "
    "'MTA Bus Co.' — an operator, not a borough."
)


def borough_of(route_id: str) -> str | None:
    """Route-ID-prefix borough. Returns None only if the prefix is unrecognised."""
    r = (route_id or "").strip().upper()
    if not r:
        return None
    if r.startswith("BX"):
        return "Bx"
    if r.startswith("SIM"):
        return "SIM"
    if r.startswith("X"):
        return "X"
    return {"M": "M", "B": "B", "Q": "Q", "S": "S"}.get(r[0])


def _route_catalog() -> list[dict[str, Any]]:
    return gtfs.get_route_catalog()


def _route_meta(route_id: str) -> dict[str, Any]:
    for r in _route_catalog():
        if r["route_id"] == route_id:
            b = borough_of(route_id)
            return {
                "route_id": route_id,
                "short_name": r.get("short_name") or route_id,
                "long_name": r.get("long_name") or "",
                "color": r.get("color") or "2563eb",
                "borough_code": b,
                "borough": _BOROUGH_NAME.get(b or "", "unknown"),
                "borough_basis": "route_id_prefix",
            }
    b = borough_of(route_id)
    return {
        "route_id": route_id, "short_name": route_id, "long_name": "",
        "color": "2563eb", "borough_code": b,
        "borough": _BOROUGH_NAME.get(b or "", "unknown"),
        "borough_basis": "route_id_prefix",
    }


# --------------------------------------------------------------------------- #
# 1) /api/autostats/completeness — make the gaps VISIBLE
# --------------------------------------------------------------------------- #
_NOT_SUPPORTED = [
    {
        "metric": "day-of-week comparison (e.g. 'Tuesdays are worse')",
        "status": "NOT BUILT",
        "reason": (
            "There is at most one observation per weekday in this archive and the single "
            "Tuesday is ~82% missing. Any weekday effect is confounded 1:1 with the calendar "
            "date, so a weekday number would be a date number wearing a weekday label."
        ),
        "unblocks_at": "several complete observations of each weekday (>= ~4 weeks)",
    },
    {
        "metric": "week-over-week change",
        "status": "NOT BUILT",
        "reason": "The archive is not yet one full week of complete days.",
        "unblocks_at": ">= 2 complete weeks",
    },
    {
        "metric": "seasonal / month-over-month change",
        "status": "NOT BUILT",
        "reason": "The archive begins 2026-07-17. There is no second season to compare to.",
        "unblocks_at": ">= 2 seasons",
    },
    {
        "metric": "subway headway / bunching",
        "status": "NOT BUILT HERE",
        "reason": (
            "No subway statistic is derived in this module. Nothing subway-shaped is "
            "stubbed, estimated or copied from the bus side."
        ),
        "unblocks_at": "a genuine subway derivation landing in derive2",
    },
]


def _completeness_payload() -> dict[str, Any]:
    dq = _dq()
    days = sorted(dq)
    per_day = []
    for d in days:
        info = dq[d]
        per_day.append({
            "archive_day_utc": d,
            "generated_at": info["generated_at"],
            "hours": info["hours"],
            "status_counts": info["status_counts"],
            "coverage_pct_mean": info["coverage_pct_mean"],
            "equivalent_complete_days": info["equivalent_complete_days"],
            "complete": info["complete"],
            "excluded_utc_hours": info["excluded_utc_hours"],
            "excluded_local_hours": info["excluded_local_hours"],
            "known_gaps": info["known_gaps"],
            "partial_hours_all_feeds": info["partial_hours"],
            "missing_hours_all_feeds": info["missing_hours"],
        })
    stamp = _coverage_stamp()
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "feed": _DQ_FEED,
        "headline": (
            f"{stamp['archive_day_directories']} archive day-folders, but only "
            f"{stamp['equivalent_complete_days']} equivalent complete days of bus data, of "
            f"which {stamp['complete_days']} are genuinely complete."
        ),
        "equivalent_complete_days": stamp["equivalent_complete_days"],
        "equivalent_complete_days_method": (
            "For each archive day, every hour's coverage_pct (capped at 100) is summed and "
            "divided by 24. Summing that across days gives equivalent complete days — the "
            "honest depth. Counting date= directories does not."
        ),
        "complete_days": stamp["complete_days"],
        "complete_day_list": stamp["complete_day_list"],
        "complete_day_rule": stamp["complete_day_rule"],
        "status_vocabulary": {
            "ok": "hour present at >= 60% of the baseline row count for that feed x hour-of-day",
            "partial": "hour present but below 60% of baseline — EXCLUDED from every statistic",
            "missing": "hour absent with no declared cause — EXCLUDED",
            "known_gap": "hour inside a declared poller outage — EXCLUDED",
            "in_progress": "hour has not finished yet (today)",
        },
        "days": per_day,
        "not_supported": _NOT_SUPPORTED,
        "archive": _archive_meta(),
        "coverage": stamp,
    }


@router.get("/completeness")
async def autostats_completeness() -> JSONResponse:
    return JSONResponse(_cached("completeness", 300, _completeness_payload))


# --------------------------------------------------------------------------- #
# 2) /api/autostats/route/{route_id}/today — plain-language route summary
# --------------------------------------------------------------------------- #
_VERDICT_RULE = [
    f"1. fewer than {MIN_TODAY_HEADWAYS} observed gaps today -> not_enough_data (no verdict).",
    f"2. else if {V_BUNCH:.0%} or more of today's gaps were shorter than HALF the scheduled "
    f"gap -> bunching.",
    f"3. else if the typical observed gap is {V_LONG:.2f}x the scheduled gap or more -> "
    f"longer_waits.",
    f"4. else if the typical observed gap is {V_SHORT:.2f}x the scheduled gap or less -> "
    f"more_frequent_than_scheduled.",
    f"5. else if the gap-to-gap coefficient of variation is {V_CV:.2f} or more -> uneven.",
    "6. otherwise -> close_to_schedule.",
]


def _verdict(n_headways: int, ratio: float | None, bunch: float | None,
             cv: float | None) -> tuple[str, str]:
    if n_headways < MIN_TODAY_HEADWAYS:
        return ("not_enough_data",
                f"Only {n_headways} bus-to-bus gaps have been observed on this route so far "
                f"today — below the {MIN_TODAY_HEADWAYS}-gap floor this API requires before "
                f"it will judge a route. No verdict is issued.")
    if bunch is not None and bunch >= V_BUNCH:
        return ("bunching",
                f"Buses are bunching: {bunch:.0%} of today's gaps were less than half the "
                f"scheduled gap, which is at or above the {V_BUNCH:.0%} bunching threshold. "
                f"Riders feel this as a long wait followed by two buses at once.")
    if ratio is not None and ratio >= V_LONG:
        return ("longer_waits",
                f"Waits are longer than scheduled: the typical gap between buses is "
                f"{ratio:.2f} times the scheduled gap (threshold {V_LONG:.2f}).")
    if ratio is not None and ratio <= V_SHORT:
        return ("more_frequent_than_scheduled",
                f"Buses came more often than the timetable says: the typical gap is "
                f"{ratio:.2f} times the scheduled gap (threshold {V_SHORT:.2f}). That can mean "
                f"added service, or that the schedule this is compared against is looser than "
                f"what actually ran.")
    if cv is not None and cv >= V_CV:
        return ("uneven",
                f"Service is uneven rather than late: the typical gap is close to schedule, but "
                f"gap lengths vary a lot (coefficient of variation {cv:.2f}, threshold "
                f"{V_CV:.2f}). Waits are unpredictable.")
    return ("close_to_schedule",
            "Service is running close to its schedule: the typical gap between buses matches "
            "the timetable, bunching is below threshold, and gap lengths are consistent.")


def _route_today_payload(route_id: str, date_str: str) -> dict[str, Any]:
    t0 = time.time()
    meta = _route_meta(route_id)
    files = _files_for_local_dates([date_str])
    dq = _dq()
    now_local = _local_now()
    is_today = date_str == _today_local()
    hours_elapsed = (now_local.hour + 1) if is_today else 24
    excl = sorted(set(dq.get(date_str, {}).get("excluded_local_hours", []))
                  | set(dq.get(_next_day(date_str), {}).get("excluded_local_hours", [])))

    if is_today and set(range(hours_elapsed)) <= set(excl):
        empty_why = (
            f"Every local hour elapsed so far today (00-{hours_elapsed - 1:02d}) is still "
            f"flagged in-progress/partial in the archive, so none of it is admissible yet. "
            f"Data exists; it is withheld rather than published half-collected."
        )
    elif excl:
        empty_why = (
            f"No admissible bus-to-bus gaps for this route on this service day. Local hour(s) "
            f"{', '.join(f'{h:02d}' for h in excl)} were dropped as partial/missing."
        )
    else:
        empty_why = ("No observed bus-to-bus gaps have been recorded for this route on this "
                     "service day yet.")
    empty = {
        "route": route_id, "meta": meta, "date": date_str, "is_today": is_today,
        "verdict_code": "not_enough_data",
        "verdict": empty_why,
        "coverage_caveat": (
            f"0 of the {hours_elapsed} hours elapsed so far today are admissible."
            if is_today else f"0 of 24 hours on {date_str} are admissible."
        ),
        "observed": {
            "n_headways": 0, "hours_observed": 0,
            "hours_elapsed_local": hours_elapsed, "hours_excluded_local": excl,
        },
        "baseline": None,
        "verdict_rule": _VERDICT_RULE,
        "archive": _archive_meta([date_str]),
        "coverage": _coverage_stamp(),
    }
    if not files:
        return empty

    con = _con()
    try:
        excl_sql = _dq_exclusion_sql()
        row = con.execute(
            f"""
            SELECT sum(n_headways)                                          AS n_headways,
                   count(*)                                                 AS n_cells,
                   count(DISTINCT local_hour)                               AS n_hours,
                   count(DISTINCT stop_id)                                  AS n_stops,
                   median(median_headway_s)                                 AS obs_med_s,
                   median(sched_median_headway_s)                           AS sch_med_s,
                   sum(bunch_share_lt50_sched * n_headways)
                       / nullif(sum(CASE WHEN bunch_share_lt50_sched IS NOT NULL
                                         THEN n_headways END), 0)           AS bunch,
                   sum(headway_cv * n_headways)
                       / nullif(sum(CASE WHEN headway_cv IS NOT NULL
                                         THEN n_headways END), 0)           AS cv,
                   median(headway_deviation_s)                              AS dev_s
            FROM read_parquet({_plist(files)})
            WHERE route_id = ? AND local_date = ?
              AND n_headways >= {MIN_CELL_HEADWAYS}
              AND {excl_sql}
            """,
            [route_id, date_str],
        ).fetchone()
        hours = con.execute(
            f"""
            SELECT local_hour, sum(n_headways), median(median_headway_s),
                   median(sched_median_headway_s)
            FROM read_parquet({_plist(files)})
            WHERE route_id = ? AND local_date = ?
              AND n_headways >= {MIN_CELL_HEADWAYS}
              AND {excl_sql}
            GROUP BY 1 ORDER BY 1
            """,
            [route_id, date_str],
        ).fetchall()

        # baseline: the SAME clock hours pooled over the other observed dates. This is a
        # time-of-day baseline, NOT a day-of-week baseline (see not_supported).
        obs_hours = [int(h[0]) for h in hours]
        baseline = None
        if obs_hours:
            all_files = _hw_files(_partition_dates())
            hlist = ",".join(str(h) for h in obs_hours)
            b = con.execute(
                f"""
                SELECT sum(n_headways), count(DISTINCT local_date),
                       median(median_headway_s), median(sched_median_headway_s),
                       sum(bunch_share_lt50_sched * n_headways)
                           / nullif(sum(CASE WHEN bunch_share_lt50_sched IS NOT NULL
                                             THEN n_headways END), 0)
                FROM read_parquet({_plist(all_files)})
                WHERE route_id = ? AND local_date <> ? AND local_hour IN ({hlist})
                  AND n_headways >= {MIN_CELL_HEADWAYS}
                  AND {excl_sql}
                """,
                [route_id, date_str],
            ).fetchone()
            if b and b[0]:
                baseline = {
                    "basis": "same clock hours, pooled over the other observed service days",
                    "hours_matched": obs_hours,
                    "n_prior_days": int(b[1] or 0),
                    "n_headways": int(b[0]),
                    "median_headway_min": round(b[2] / 60.0, 1) if b[2] is not None else None,
                    "sched_median_headway_min": round(b[3] / 60.0, 1) if b[3] is not None else None,
                    "bunched_gap_share": round(b[4], 3) if b[4] is not None else None,
                    "not_day_of_week_matched": True,
                    "note": (
                        "Pooled across calendar dates, NOT matched on weekday. The archive "
                        "cannot support a day-of-week comparison."
                    ),
                }
    finally:
        con.close()

    if not row or not row[0]:
        return empty

    n = int(row[0])
    obs_s, sch_s = row[4], row[5]
    ratio = (obs_s / sch_s) if (obs_s and sch_s) else None
    bunch = float(row[6]) if row[6] is not None else None
    cv = float(row[7]) if row[7] is not None else None
    code, sentence = _verdict(n, ratio, bunch, cv)

    hours_observed = int(row[2] or 0)
    coverage_line = (
        f"Based on {hours_observed} of the {hours_elapsed} hours that have elapsed so far "
        f"today ({hours_observed / hours_elapsed:.0%} of the day so far)."
        if is_today else
        f"Based on {hours_observed} of 24 hours on {date_str}."
    )
    if excl:
        coverage_line += (
            f" Local hour(s) {', '.join(f'{h:02d}' for h in excl)} were dropped as "
            f"partial/missing in the archive."
        )

    return {
        "route": route_id,
        "meta": meta,
        "date": date_str,
        "is_today": is_today,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "verdict_code": code,
        "verdict": sentence,
        "verdict_rule": _VERDICT_RULE,
        "plain_summary": (
            f"{meta['short_name']} ({_BOROUGH_NAME.get(meta['borough_code'] or '', 'unknown')}): "
            f"buses came about every "
            f"{round(obs_s / 60.0, 1) if obs_s else '?'} minutes"
            + (f" against a scheduled {round(sch_s / 60.0, 1)} minutes" if sch_s else "")
            + (f"; {bunch:.0%} of gaps were less than half the scheduled gap" if bunch is not None else "")
            + ". " + sentence + " " + coverage_line
        ),
        "coverage_caveat": coverage_line,
        "observed": {
            "n_headways": n,
            "n_cells": int(row[1] or 0),
            "n_stops": int(row[3] or 0),
            "hours_observed": hours_observed,
            "hours_elapsed_local": hours_elapsed,
            "hours_excluded_local": excl,
            "median_headway_s": round(obs_s, 1) if obs_s is not None else None,
            "median_headway_min": round(obs_s / 60.0, 1) if obs_s is not None else None,
            "sched_median_headway_s": round(sch_s, 1) if sch_s is not None else None,
            "sched_median_headway_min": round(sch_s / 60.0, 1) if sch_s is not None else None,
            "observed_over_scheduled": round(ratio, 3) if ratio is not None else None,
            "median_headway_deviation_s": round(row[8], 1) if row[8] is not None else None,
            "bunched_gap_share": round(bunch, 3) if bunch is not None else None,
            "headway_cv": round(cv, 3) if cv is not None else None,
            "by_hour": [
                {"local_hour": int(h[0]), "n_headways": int(h[1] or 0),
                 "median_headway_min": round(h[2] / 60.0, 1) if h[2] is not None else None,
                 "sched_median_headway_min": round(h[3] / 60.0, 1) if h[3] is not None else None}
                for h in hours
            ],
        },
        "baseline": baseline,
        "definitions": {
            "gap": "the time between one bus and the next at the same stop, same direction",
            "bunched_gap_share": (
                "share of observed gaps shorter than half the scheduled gap at that stop-hour"
            ),
            "headway_cv": "standard deviation of gaps divided by their mean; 0 = perfectly even",
        },
        "suppression": {
            "min_headways_per_cell": MIN_CELL_HEADWAYS,
            "min_headways_for_verdict": MIN_TODAY_HEADWAYS,
            "note": (
                f"Stop-hour cells with fewer than {MIN_CELL_HEADWAYS} observed gaps are dropped "
                f"before anything is computed; below {MIN_TODAY_HEADWAYS} total gaps no verdict "
                f"is issued at all."
            ),
        },
        "archive": _archive_meta([date_str]),
        "coverage": _coverage_stamp(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/route/{route_id}/today")
async def autostats_route_today(route_id: str, date: str | None = None) -> JSONResponse:
    date_str = date or _today_local()
    key = f"today|{route_id}|{date_str}"
    return JSONResponse(_cached(key, 120, lambda: _route_today_payload(route_id, date_str)))


# --------------------------------------------------------------------------- #
# 3) /api/autostats/profile — time-of-day reliability profile (the FLAGSHIP)
# --------------------------------------------------------------------------- #
_PROFILE_NOTE = (
    "Within-day time-of-day profile: every observed service day is pooled into 24 local-hour "
    "buckets. This is the strongest evidence base in the archive because each hour is observed "
    "on several dates. It is explicitly NOT a weekday profile — the hours are pooled across "
    "calendar dates and the archive cannot separate weekday from date."
)


def _profile_payload(route_id: str | None, borough_code: str | None,
                     direction: int | None) -> dict[str, Any]:
    t0 = time.time()
    files = _hw_files(_partition_dates())
    stamp = _coverage_stamp()
    base = {
        "route": route_id,
        "borough_code": borough_code,
        "borough": _BOROUGH_NAME.get(borough_code or "", None) if borough_code else None,
        "direction": direction,
        "grain": "local_hour",
        "note": _PROFILE_NOTE,
        "borough_note": _BOROUGH_NOTE if borough_code else None,
        "suppression": {
            "min_headways_per_cell": MIN_CELL_HEADWAYS,
            "min_headways_per_published_hour": MIN_HOUR_HEADWAYS,
            "min_cells_per_published_hour": MIN_HOUR_CELLS,
            "rule": (
                f"A stop x hour x day cell enters the pool only with >= {MIN_CELL_HEADWAYS} "
                f"observed gaps. An hour is PUBLISHED only with >= {MIN_HOUR_HEADWAYS} gaps "
                f"from >= {MIN_HOUR_CELLS} cells; otherwise the hour is returned with "
                f"suppressed=true and null statistics rather than a noisy number."
            ),
        },
        "archive": _archive_meta(),
        "coverage": stamp,
    }
    if not files:
        return {**base, "hours": [], "no_data": True}

    where = [f"n_headways >= {MIN_CELL_HEADWAYS}", _dq_exclusion_sql()]
    params: list[Any] = []
    if route_id:
        where.append("route_id = ?")
        params.append(route_id)
    if direction is not None:
        where.append("direction_id = ?")
        params.append(direction)
    if borough_code:
        rids = [r["route_id"] for r in _route_catalog() if borough_of(r["route_id"]) == borough_code]
        if not rids:
            return {**base, "hours": [], "no_data": True}
        where.append("route_id IN (" + ",".join(_q(r) for r in rids) + ")")

    con = _con()
    try:
        rows = con.execute(
            f"""
            SELECT local_hour,
                   sum(n_headways)                       AS n_headways,
                   count(*)                              AS n_cells,
                   count(DISTINCT local_date)            AS n_days,
                   count(DISTINCT route_id)              AS n_routes,
                   count(DISTINCT stop_id)               AS n_stops,
                   median(median_headway_s)              AS med_hw_s,
                   median(sched_median_headway_s)        AS sched_hw_s,
                   median(headway_cv)                    AS med_cv,
                   sum(bunch_share_lt50_sched * n_headways)
                       / nullif(sum(CASE WHEN bunch_share_lt50_sched IS NOT NULL
                                         THEN n_headways END), 0) AS bunch,
                   median(headway_deviation_s)           AS dev_s
            FROM read_parquet({_plist(files)})
            WHERE {' AND '.join(where)}
            GROUP BY 1 ORDER BY 1
            """,
            params,
        ).fetchall()
    finally:
        con.close()

    by_hour = {int(r[0]): r for r in rows}
    hours = []
    n_pub = n_sup = 0
    for h in range(24):
        r = by_hour.get(h)
        if r is None:
            hours.append({"local_hour": h, "suppressed": True,
                          "suppressed_reason": "no observations in this hour",
                          "n_headways": 0, "n_cells": 0, "n_days": 0,
                          "median_headway_min": None, "headway_cv": None,
                          "bunched_gap_share": None})
            n_sup += 1
            continue
        nh, nc = int(r[1] or 0), int(r[2] or 0)
        if nh < MIN_HOUR_HEADWAYS or nc < MIN_HOUR_CELLS:
            hours.append({
                "local_hour": h, "suppressed": True,
                "suppressed_reason": (
                    f"below the publish floor ({nh} gaps from {nc} cells; needs "
                    f">= {MIN_HOUR_HEADWAYS} gaps from >= {MIN_HOUR_CELLS} cells)"
                ),
                "n_headways": nh, "n_cells": nc, "n_days": int(r[3] or 0),
                "median_headway_min": None, "headway_cv": None, "bunched_gap_share": None,
            })
            n_sup += 1
            continue
        med, sch = r[6], r[7]
        hours.append({
            "local_hour": h,
            "suppressed": False,
            "n_headways": nh,
            "n_cells": nc,
            "n_days": int(r[3] or 0),
            "n_routes": int(r[4] or 0),
            "n_stops": int(r[5] or 0),
            "median_headway_s": round(med, 1) if med is not None else None,
            "median_headway_min": round(med / 60.0, 1) if med is not None else None,
            "sched_median_headway_min": round(sch / 60.0, 1) if sch is not None else None,
            "observed_over_scheduled": round(med / sch, 3) if (med and sch) else None,
            "median_headway_deviation_s": round(r[10], 1) if r[10] is not None else None,
            "headway_cv": round(r[8], 3) if r[8] is not None else None,
            "bunched_gap_share": round(r[9], 3) if r[9] is not None else None,
        })
        n_pub += 1

    published = [h for h in hours if not h["suppressed"]]
    worst = max(published, key=lambda x: (x["bunched_gap_share"] or -1), default=None)
    best = min(published, key=lambda x: (x["bunched_gap_share"] if x["bunched_gap_share"]
                                         is not None else 1e9), default=None)
    return {
        **base,
        "hours": hours,
        "hours_published": n_pub,
        "hours_suppressed": n_sup,
        "n_headways_total": sum(h["n_headways"] for h in hours),
        "worst_hour": ({"local_hour": worst["local_hour"],
                        "bunched_gap_share": worst["bunched_gap_share"]} if worst else None),
        "best_hour": ({"local_hour": best["local_hour"],
                       "bunched_gap_share": best["bunched_gap_share"]} if best else None),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/profile")
async def autostats_profile(
    route: str | None = None,
    borough: str | None = None,
    direction: int | None = None,
) -> JSONResponse:
    bcode = None
    if borough:
        b = borough.strip()
        for code in _BOROUGH_ORDER:
            if code.lower() == b.lower() or _BOROUGH_NAME[code].lower() == b.lower():
                bcode = code
                break
        if bcode is None:
            return JSONResponse(
                {"error": f"unknown borough '{borough}'", "valid": _BOROUGH_ORDER}, status_code=400
            )
    key = f"profile|{route}|{bcode}|{direction}"
    return JSONResponse(_cached(key, 600, lambda: _profile_payload(route, bcode, direction)))


# --------------------------------------------------------------------------- #
# 4) /api/autostats/boroughs — route-level stats rolled up to the HOME borough
# --------------------------------------------------------------------------- #
_NORMALISATION_NOTE = (
    "Routes are NOT observed for the same hours: the archive has partial and missing hours, "
    "and routes have different service spans. Every route statistic below is therefore built "
    "per route x local_hour FIRST (dropping partial/missing hours and thin cells), and the "
    "route number is the median ACROSS THE HOURS THAT ROUTE WAS ACTUALLY OBSERVED. A route "
    "that only ran at 3am is therefore not compared against a route observed all day on raw "
    "pooled gaps. `hours_observed` is published per route so the normalisation is auditable."
)


def _boroughs_payload() -> dict[str, Any]:
    t0 = time.time()
    cat = _route_catalog()
    files = _hw_files(_partition_dates())

    # --- the prefix rollup over the FULL GTFS route universe (independent of observation) ---
    by_borough: dict[str, list[str]] = {c: [] for c in _BOROUGH_ORDER}
    fallbacks: list[str] = []
    for r in cat:
        b = borough_of(r["route_id"])
        if b is None:
            fallbacks.append(r["route_id"])
        else:
            by_borough[b].append(r["route_id"])

    route_stats: dict[str, dict[str, Any]] = {}
    if files:
        con = _con()
        try:
            rows = con.execute(
                f"""
                WITH cells AS (
                    SELECT route_id, local_hour, local_date, n_headways, median_headway_s,
                           sched_median_headway_s, headway_cv, bunch_share_lt50_sched,
                           headway_deviation_s
                    FROM read_parquet({_plist(files)})
                    WHERE n_headways >= {MIN_CELL_HEADWAYS} AND {_dq_exclusion_sql()}
                ),
                per_hour AS (
                    SELECT route_id, local_hour,
                           sum(n_headways)                AS nh,
                           median(median_headway_s)       AS med_s,
                           median(sched_median_headway_s) AS sch_s,
                           median(headway_cv)             AS cv,
                           sum(bunch_share_lt50_sched * n_headways)
                             / nullif(sum(CASE WHEN bunch_share_lt50_sched IS NOT NULL
                                               THEN n_headways END), 0) AS bunch,
                           median(headway_deviation_s)    AS dev_s,
                           count(DISTINCT local_date)     AS ndays
                    FROM cells GROUP BY 1, 2
                )
                SELECT route_id,
                       count(*)          AS hours_observed,
                       sum(nh)           AS n_headways,
                       median(med_s)     AS med_s,
                       median(sch_s)     AS sch_s,
                       median(cv)        AS cv,
                       median(bunch)     AS bunch,
                       median(dev_s)     AS dev_s,
                       max(ndays)        AS max_days
                FROM per_hour GROUP BY 1
                """
            ).fetchall()
        finally:
            con.close()
        for r in rows:
            route_stats[r[0]] = {
                "hours_observed": int(r[1] or 0),
                "n_headways": int(r[2] or 0),
                "median_headway_s": r[3],
                "sched_median_headway_s": r[4],
                "headway_cv": r[5],
                "bunched_gap_share": r[6],
                "median_headway_deviation_s": r[7],
                "max_days_any_hour": int(r[8] or 0),
            }

    def _median(v: list[float]) -> float | None:
        v = sorted(x for x in v if x is not None)
        if not v:
            return None
        n = len(v)
        return v[n // 2] if n % 2 else (v[n // 2 - 1] + v[n // 2]) / 2.0

    boroughs = []
    for code in _BOROUGH_ORDER:
        rids = sorted(by_borough[code])
        qual = [rid for rid in rids
                if rid in route_stats and route_stats[rid]["n_headways"] >= MIN_ROUTE_HEADWAYS]
        med_hw = _median([route_stats[r]["median_headway_s"] for r in qual])
        sch_hw = _median([route_stats[r]["sched_median_headway_s"] for r in qual])
        cv = _median([route_stats[r]["headway_cv"] for r in qual])
        bunch = _median([route_stats[r]["bunched_gap_share"] for r in qual])
        dev = _median([route_stats[r]["median_headway_deviation_s"] for r in qual])
        hours_obs = _median([float(route_stats[r]["hours_observed"]) for r in qual])
        worst = sorted(
            ({"route_id": r, "short_name": _route_meta(r)["short_name"],
              "bunched_gap_share": round(route_stats[r]["bunched_gap_share"], 3)
              if route_stats[r]["bunched_gap_share"] is not None else None,
              "hours_observed": route_stats[r]["hours_observed"],
              "n_headways": route_stats[r]["n_headways"]}
             for r in qual if route_stats[r]["bunched_gap_share"] is not None),
            key=lambda x: -(x["bunched_gap_share"] or 0),
        )[:5]
        boroughs.append({
            "borough_code": code,
            "borough": _BOROUGH_NAME[code],
            "n_routes_total": len(rids),
            "n_routes_observed": sum(1 for r in rids if r in route_stats),
            "n_routes_qualifying": len(qual),
            "route_ids": rids,
            "median_headway_s": round(med_hw, 1) if med_hw is not None else None,
            "median_headway_min": round(med_hw / 60.0, 1) if med_hw is not None else None,
            "sched_median_headway_min": round(sch_hw / 60.0, 1) if sch_hw is not None else None,
            "median_headway_cv": round(cv, 3) if cv is not None else None,
            "median_bunched_gap_share": round(bunch, 3) if bunch is not None else None,
            "median_headway_deviation_s": round(dev, 1) if dev is not None else None,
            "median_hours_observed_per_route": hours_obs,
            "most_bunched_routes": worst,
        })

    total = sum(b["n_routes_total"] for b in boroughs)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "borough_basis": "route_id_prefix",
        "borough_note": _BOROUGH_NOTE,
        "normalisation_note": _NORMALISATION_NOTE,
        "rollup_statistic": (
            "Each borough number is the MEDIAN over its qualifying routes of that route's own "
            "median across observed hours. Routes are weighted equally — a borough number is "
            "'the typical route here', not a passenger-weighted or vehicle-weighted average."
        ),
        "totals": {
            "n_routes_in_catalog": len(cat),
            "n_routes_assigned": total,
            "n_routes_unassigned_fallback": len(fallbacks),
            "fallback_route_ids": fallbacks,
            "sums_to_catalog": total == len(cat) and not fallbacks,
            "by_borough": {b["borough_code"]: b["n_routes_total"] for b in boroughs},
        },
        "suppression": {
            "min_headways_per_cell": MIN_CELL_HEADWAYS,
            "min_headways_per_route": MIN_ROUTE_HEADWAYS,
            "rule": (
                f"A route joins its borough rollup only with >= {MIN_ROUTE_HEADWAYS} observed "
                f"gaps across cells of >= {MIN_CELL_HEADWAYS} gaps each, after partial/missing "
                f"hours are dropped."
            ),
        },
        "boroughs": boroughs,
        "archive": _archive_meta(),
        "coverage": _coverage_stamp(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/boroughs")
async def autostats_boroughs() -> JSONResponse:
    return JSONResponse(_cached("boroughs", 600, _boroughs_payload))


# --------------------------------------------------------------------------- #
# 5) /api/autostats/route/{route_id}/slowspots — where on a route service degrades
# --------------------------------------------------------------------------- #
def _dominant_shape(con, route_id: str, direction: int) -> str | None:
    """The shape MOST TRIPS use — the offset space derive2's trajectories/speed table live in."""
    row = con.execute(
        f"""SELECT shape_id, count(*) n FROM read_parquet('{_cache_file("trip_meta")}')
            WHERE route_id = ? AND direction_id = ? AND shape_id IS NOT NULL AND shape_id <> ''
            GROUP BY 1 ORDER BY n DESC LIMIT 1""",
        [route_id, direction],
    ).fetchone()
    return row[0] if row else None


def _shape_stops(con, shape_id: str) -> list[dict[str, Any]]:
    rows = con.execute(
        f"""SELECT so.stop_id, coalesce(s.stop_name, so.stop_id), so.stop_offset_ft, so.stop_seq
            FROM read_parquet('{_cache_file("stop_offsets")}') so
            LEFT JOIN read_parquet('{_cache_file("stops")}') s ON s.stop_id = so.stop_id
            WHERE so.shape_id = ? ORDER BY so.stop_offset_ft""",
        [shape_id],
    ).fetchall()
    return [{"stop_id": r[0], "name": r[1], "offset_ft": round(float(r[2]), 1), "stop_seq": r[3]}
            for r in rows]


def _slowspots_payload(route_id: str) -> dict[str, Any]:
    t0 = time.time()
    meta = _route_meta(route_id)
    con = _con()
    try:
        # ---- A. stop-pair segments (MTA bus-speeds analysis, AM/PM peak) ----------------
        try:
            seg_rows = con.execute(
                f"""SELECT s.from_stop, s.to_stop, s.wt_speed_mph, s.n_trips, s.seg_miles,
                           g.from_lat, g.from_lon, g.to_lat, g.to_lon
                    FROM read_parquet('{_bus_file("02_all_segments_peak")}') s
                    LEFT JOIN read_parquet('{_bus_file("02_segment_geometry")}') g
                      ON g.route_id = s.route_id AND g.from_stop = s.from_stop
                     AND g.to_stop = s.to_stop
                    WHERE s.route_id = ?""",
                [route_id],
            ).fetchall()
        except Exception:
            seg_rows = []

        speeds = sorted(float(r[2]) for r in seg_rows if r[2] is not None)
        n = len(speeds)
        route_median_mph = round(speeds[n // 2], 2) if n else None

        def _pctile(v: float) -> float:
            if n <= 1:
                return 0.5
            return round(sum(1 for s in speeds if s < v) / (n - 1), 4)

        stop_pairs = [
            {
                "from_stop": r[0], "to_stop": r[1],
                "wt_speed_mph": round(float(r[2]), 2),
                "speed_pctile_within_route": _pctile(float(r[2])),
                "vs_route_median": (round(float(r[2]) / route_median_mph, 3)
                                    if route_median_mph else None),
                "n_trips": int(r[3]) if r[3] is not None else None,
                "seg_miles": round(float(r[4]), 3) if r[4] is not None else None,
                "coords": ([[round(r[5], 6), round(r[6], 6)], [round(r[7], 6), round(r[8], 6)]]
                           if r[5] is not None and r[7] is not None else None),
            }
            for r in seg_rows if r[2] is not None
        ]
        stop_pairs.sort(key=lambda x: x["wt_speed_mph"])

        # ---- B. observed half-mile bins from the derive2 speed table (directional) ------
        seg_file = (config.DERIVED_ROOT / "route_segment_speeds" / "segment-000.parquet").as_posix()
        rte_file = (config.DERIVED_ROOT / "route_segment_speeds" / "route-000.parquet").as_posix()
        try:
            route_fps = con.execute(
                f"SELECT median_fps, n FROM read_parquet('{rte_file}') WHERE route_id = ?",
                [route_id],
            ).fetchone()
        except Exception:
            route_fps = None
        try:
            bin_rows = con.execute(
                f"""SELECT direction_id, seg_bin, median_fps, n FROM read_parquet('{seg_file}')
                    WHERE route_id = ? ORDER BY direction_id, seg_bin""",
                [route_id],
            ).fetchall()
        except Exception:
            bin_rows = []

        SEG_BIN_FT = 2640.0
        stops_by_dir: dict[int, list[dict]] = {}
        for d in sorted({int(r[0]) for r in bin_rows if r[0] is not None}):
            shp = _dominant_shape(con, route_id, d)
            stops_by_dir[d] = _shape_stops(con, shp) if shp else []

        observed_bins = []
        suppressed_bins = 0
        rmed = float(route_fps[0]) if route_fps and route_fps[0] else None
        for d, b, fps, cnt in bin_rows:
            d, b, cnt = int(d), int(b), int(cnt or 0)
            lo, hi = b * SEG_BIN_FT, (b + 1) * SEG_BIN_FT
            stops = stops_by_dir.get(d, [])
            covered = [s for s in stops if lo <= s["offset_ft"] < hi]
            entry = {
                "direction_id": d, "seg_bin": b,
                "offset_from_ft": lo, "offset_to_ft": hi,
                "n_observations": cnt,
                "from_stop": covered[0]["name"] if covered else None,
                "to_stop": covered[-1]["name"] if covered else None,
                "stops_in_bin": len(covered),
                # a bin can sit past the end of the most-used shape when the observations
                # came from a LONGER shape variant; label it rather than guess a stop.
                "beyond_labelling_shape": bool(stops and lo >= stops[-1]["offset_ft"]),
            }
            if cnt < MIN_SEG_OBS:
                entry.update({"suppressed": True,
                              "suppressed_reason": f"{cnt} observations < {MIN_SEG_OBS} floor",
                              "median_speed_mph": None, "vs_route_median": None})
                suppressed_bins += 1
            else:
                mph = float(fps) * 3600.0 / 5280.0
                entry.update({
                    "suppressed": False,
                    "median_speed_fps": round(float(fps), 3),
                    "median_speed_mph": round(mph, 2),
                    "vs_route_median": round(float(fps) / rmed, 3) if rmed else None,
                })
            observed_bins.append(entry)
        published = [b for b in observed_bins if not b["suppressed"]]
        published_sorted = sorted(published, key=lambda x: x["median_speed_mph"])
    finally:
        con.close()

    return {
        "route": route_id,
        "meta": meta,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "route_median_speed_mph": route_median_mph,
        "route_observed_median_speed_mph": (round(rmed * 3600.0 / 5280.0, 2) if rmed else None),
        "route_observed_n": int(route_fps[1]) if route_fps and route_fps[1] else None,
        "stop_pair_segments": {
            # Name the DATASET, not the internal tree it happens to sit in — this string
            # is served to visitors on the public API.
            "source": "Bus segment speeds analysis (02_all_segments_peak + 02_segment_geometry)",
            "method": (
                "Trip-weighted through-speed between consecutive scheduled timepoints in the "
                "AM/PM peak, from the MTA bus-speeds analysis. n_trips is the sample size. "
                "Ranked slowest-first; `speed_pctile_within_route` is 0 at the route's slowest "
                "segment and 1 at its fastest."
            ),
            "n_segments": len(stop_pairs),
            "slowest_10": stop_pairs[:10],
            "segments": stop_pairs,
        },
        "observed_half_mile_bins": {
            "source": "realtime/derived/route_segment_speeds/segment-000.parquet (derive2 3b)",
            "method": (
                "Median along-shape speed d(offset)/d(t) on derive2's 30 s resampled "
                "trajectories, per route x direction x half-mile (2640 ft) bin, pooled over "
                "every archive day. This is OBSERVED bus movement, not a schedule."
            ),
            "caveat": (
                "Bin boundaries are offsets along each trip's own GTFS shape; the stop names "
                "attached to a bin come from the shape MOST TRIPS use, so a bin's stop labels "
                "are accurate to within one half-mile bin, not to the foot."
            ),
            "seg_bin_ft": SEG_BIN_FT,
            "n_bins": len(observed_bins),
            "n_bins_published": len(published),
            "n_bins_suppressed": suppressed_bins,
            "min_observations": MIN_SEG_OBS,
            "slowest_10": published_sorted[:10],
            "bins": observed_bins,
        },
        "archive": _archive_meta(),
        "coverage": _coverage_stamp(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/route/{route_id}/slowspots")
async def autostats_slowspots(route_id: str) -> JSONResponse:
    return JSONResponse(_cached(f"slow|{route_id}", 600, lambda: _slowspots_payload(route_id)))


# --------------------------------------------------------------------------- #
# 6) /api/autostats/ladder — THE ROUTE LADDER
# --------------------------------------------------------------------------- #
# An ordered stop list per direction with live vehicles interleaved at their true
# along-shape position. Bunching is legible as two vehicle rows between the same pair of
# stops — no statistic, no threshold to defend.
#
# Offset space: vehicles carry `route_offset_ft` from app.motion, measured against the
# canonical (most-detailed) shape in app.busshapes' LUT. The ladder therefore takes its
# stop offsets from THAT SAME shape_id, so vehicle and stop offsets are directly comparable.
# --------------------------------------------------------------------------- #
_VOCABULARY = {
    "at stop": f"within {AT_STOP_FT:.0f} ft of the stop",
    "approaching": f"within {APPROACHING_FT:.0f} ft of the stop",
    "< 1 stop away": "past the previous stop but not yet approaching this one",
    "N stops away": f"1 to {MAX_STOP_COUNT} stops back",
    "N.N miles away": (
        f"more than {MAX_STOP_COUNT} stops back — the stop count is DELIBERATELY DROPPED and "
        f"replaced by distance, because counting stops that far out implies a certainty about "
        f"intermediate stopping that the data does not carry (MTA Bus Time's own "
        f"PresentableDistance behaviour)"
    ),
}


def _presentable(distance_ft: float, stops_away: int) -> str:
    if distance_ft <= AT_STOP_FT:
        return "at stop"
    if distance_ft <= APPROACHING_FT:
        return "approaching"
    if stops_away <= 0:
        return "< 1 stop away"
    if stops_away <= MAX_STOP_COUNT:
        return f"{stops_away} stop away" if stops_away == 1 else f"{stops_away} stops away"
    return f"{distance_ft / 5280.0:.1f} miles away"


def _ladder_dir(route_id: str, direction: int, stops: list[dict[str, Any]],
                shape_id: str, shape_len_ft: float,
                vehicles: list[dict[str, Any]], as_of: int | None) -> dict[str, Any]:
    offsets = [s["offset_ft"] for s in stops]
    now = int(time.time())

    def _stops_between(a_off: float, b_off: float) -> int:
        """Stops strictly between two offsets (a < b)."""
        lo = bisect.bisect_right(offsets, a_off)
        hi = bisect.bisect_left(offsets, b_off)
        return max(0, hi - lo)

    placed: list[dict[str, Any]] = []
    for v in vehicles:
        off = v.get("route_offset_ft")
        if off is None:
            continue
        i = bisect.bisect_right(offsets, off)           # index of the NEXT stop
        prev_stop = stops[i - 1] if i > 0 else None
        next_stop = stops[i] if i < len(stops) else None
        d_next = (next_stop["offset_ft"] - off) if next_stop else None
        ts = v.get("timestamp") or as_of
        spd = v.get("speed_est_fps")
        placed.append({
            "vehicle_id": v.get("vehicle_id"),
            "trip_id": v.get("trip_id"),
            "route_offset_ft": round(float(off), 1),
            "frac_along_route": round(float(off) / shape_len_ft, 4) if shape_len_ft else None,
            "after_stop_index": i - 1,
            "between": {
                "prev_stop_id": prev_stop["stop_id"] if prev_stop else None,
                "prev_stop_name": prev_stop["name"] if prev_stop else None,
                "next_stop_id": next_stop["stop_id"] if next_stop else None,
                "next_stop_name": next_stop["name"] if next_stop else None,
            },
            "distance_to_next_stop_ft": round(d_next, 1) if d_next is not None else None,
            "distance_to_next_stop_miles": (round(d_next / 5280.0, 3)
                                            if d_next is not None else None),
            "stops_away_from_next_stop": 0 if next_stop else None,
            "presentable_distance": (_presentable(d_next, 0) if d_next is not None
                                     else "past the last stop"),
            "reported_stop_id": v.get("stop_id"),
            "bearing": v.get("bearing"),
            "timestamp": ts,
            "age_s": (now - int(ts)) if ts else None,
            "speed_est_fps": spd,
            "speed_est_mph": round(spd * 3600.0 / 5280.0, 1) if spd else None,
            "speed_basis": v.get("speed_basis"),
            "eta_next_stop_min_est": (round(d_next / spd / 60.0, 1)
                                      if (d_next is not None and spd) else None),
        })
    placed.sort(key=lambda p: p["route_offset_ft"])

    # --- bunching: consecutive vehicles closer than BUNCH_GAP_FT along the route ---------
    bunched_pairs = []
    for a, b in zip(placed, placed[1:]):
        gap = b["route_offset_ft"] - a["route_offset_ft"]
        a["gap_to_vehicle_ahead_ft"] = round(gap, 1)
        b["gap_to_vehicle_behind_ft"] = round(gap, 1)
        if gap <= BUNCH_GAP_FT:
            a.setdefault("bunched_with", []).append(b["vehicle_id"])
            b.setdefault("bunched_with", []).append(a["vehicle_id"])
            bunched_pairs.append({
                "leader_vehicle_id": b["vehicle_id"],
                "follower_vehicle_id": a["vehicle_id"],
                "gap_ft": round(gap, 1),
                "gap_miles": round(gap / 5280.0, 3),
                "between_stops": [a["between"]["prev_stop_name"], a["between"]["next_stop_name"]],
            })
    for p in placed:
        p.setdefault("gap_to_vehicle_ahead_ft", None)
        p.setdefault("gap_to_vehicle_behind_ft", None)
        p.setdefault("bunched_with", [])

    # --- stop rows, each with the nearest UPSTREAM vehicle (full degrade vocabulary) -----
    stop_rows = []
    for si, s in enumerate(stops):
        upstream = [p for p in placed if p["route_offset_ft"] <= s["offset_ft"]]
        nxt = None
        if upstream:
            p = upstream[-1]                       # closest behind this stop
            dist = s["offset_ft"] - p["route_offset_ft"]
            sa = _stops_between(p["route_offset_ft"], s["offset_ft"])
            spd = p.get("speed_est_fps")
            nxt = {
                "vehicle_id": p["vehicle_id"],
                "distance_ft": round(dist, 1),
                "distance_miles": round(dist / 5280.0, 3),
                "stops_away": sa,
                "presentable_distance": _presentable(dist, sa),
                "eta_min_est": round(dist / spd / 60.0, 1) if spd else None,
                "eta_basis": p.get("speed_basis"),
            }
        stop_rows.append({
            "index": si,
            "stop_id": s["stop_id"],
            "stop_name": s["name"],
            "stop_seq": s["stop_seq"],
            "offset_ft": s["offset_ft"],
            "vehicles_after_this_stop": [p["vehicle_id"] for p in placed
                                         if p["after_stop_index"] == si],
            "next_vehicle": nxt,
        })

    return {
        "direction_id": direction,
        "shape_id": shape_id,
        "shape_length_ft": round(shape_len_ft, 1) if shape_len_ft else None,
        "n_stops": len(stops),
        "n_vehicles": len(placed),
        "n_bunched_pairs": len(bunched_pairs),
        "bunched_pairs": bunched_pairs,
        "stops": stop_rows,
        "vehicles": placed,
    }


def _ladder_payload(route_id: str, direction: int | None) -> dict[str, Any]:
    t0 = time.time()
    meta = _route_meta(route_id)
    lut = busshapes.get_lut()
    dirs = [d for d in (lut["route_dirs"].get(route_id) or []) if (route_id, d) in lut["shapes"]]
    if direction is not None:
        dirs = [d for d in dirs if d == direction]
    if not dirs:
        return {"route": route_id, "meta": meta, "error": "no canonical GTFS shape for this route",
                "directions": [], "archive": _archive_meta(), "coverage": _coverage_stamp()}

    try:
        veh = realtime.get_vehicles()
    except Exception:
        veh = {"as_of": None, "source": "none", "stale": True, "vehicles": []}
    as_of = veh.get("as_of")
    on_route = [v for v in (veh.get("vehicles") or []) if v.get("route_id") == route_id]

    con = _con()
    try:
        out_dirs = []
        for d in sorted(dirs):
            entry = lut["shapes"][(route_id, d)]
            shape_id = entry["shape_id"]
            stops = _shape_stops(con, shape_id)
            mine = [v for v in on_route if v.get("shape_id") == shape_id]
            out_dirs.append(_ladder_dir(route_id, d, stops, shape_id,
                                        float(entry.get("shape_len_ft") or 0.0), mine, as_of))
    finally:
        con.close()

    placed_total = sum(x["n_vehicles"] for x in out_dirs)
    now = int(time.time())
    return {
        "route": route_id,
        "meta": meta,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "live": {
            "as_of": as_of,
            "age_s": (now - int(as_of)) if as_of else None,
            "source": veh.get("source"),
            "stale": veh.get("stale"),
            "vehicles_on_route": len(on_route),
            "vehicles_placed_on_ladder": placed_total,
            "vehicles_unplaced": len(on_route) - placed_total,
            "unplaced_reason": (
                "A bus is unplaced when app.motion withheld its along-shape offset — GPS more "
                "than 200 ft off the shape, or a backward offset jump > 500 ft. Those buses are "
                "counted here, never guessed onto the ladder."
            ),
        },
        "directions": out_dirs,
        "direction_labelling": (
            "Directions are GTFS direction_id. MTA's own destination-sign text "
            "(\"to SOUTH FERRY via 2 AV\") is NOT in any feed this platform archives — it "
            "exists only in the live SIRI API — so it is not shown rather than invented."
        ),
        "vocabulary": _VOCABULARY,
        "vocabulary_note": (
            "Distances degrade deliberately: beyond "
            f"{MAX_STOP_COUNT} stops the stop count is replaced by a one-decimal mileage. The "
            "raw numbers (distance_ft, stops_away) ride alongside every phrase."
        ),
        "eta_note": (
            "eta_*_min_est is a constant-speed extrapolation from the bus's current "
            "speed_est_fps (whose basis is published per vehicle), NOT an MTA arrival "
            "prediction. This platform archives no arrival predictions for buses."
        ),
        "bunching_note": (
            f"A bunched pair is two consecutive buses on the same direction within "
            f"{BUNCH_GAP_FT:.0f} ft of each other along the route. This is a rendering aid with "
            f"one stated distance threshold — it is not the derived bunching statistic, which "
            f"lives in /api/autostats/profile."
        ),
        "archive": _archive_meta(),
        "coverage": _coverage_stamp(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/ladder")
async def autostats_ladder(route: str, direction: int | None = None) -> JSONResponse:
    key = f"ladder|{route}|{direction}"
    # 15 s: the upstream vehicle payload itself refreshes on RT_CACHE_TTL_S.
    return JSONResponse(_cached(key, 15, lambda: _ladder_payload(route, direction)))


# --------------------------------------------------------------------------- #
# index
# --------------------------------------------------------------------------- #
@router.get("")
@router.get("/")
async def autostats_index() -> JSONResponse:
    return JSONResponse({
        "service": "nycvisualizer auto-stats",
        "endpoints": [
            {"path": "/api/autostats/completeness",
             "what": "archive-completeness banner: which days/hours are partial, missing, "
                     "known-gap or in-progress, plus the honest equivalent-complete-days number"},
            {"path": "/api/autostats/route/{route_id}/today",
             "what": "plain-language summary of one route today with a stated-rule verdict",
             "params": {"date": "YYYY-MM-DD local service day (default: today)"}},
            {"path": "/api/autostats/profile",
             "what": "time-of-day reliability profile by local hour (flagship)",
             "params": {"route": "route_id", "borough": "Bx|B|M|Q|S|SIM|X",
                        "direction": "0|1"}},
            {"path": "/api/autostats/boroughs",
             "what": "route-level stats rolled up to the route-ID-prefix home borough"},
            {"path": "/api/autostats/route/{route_id}/slowspots",
             "what": "corridor slow-spots: slowest stop-pairs and observed half-mile bins"},
            {"path": "/api/autostats/ladder",
             "what": "THE ROUTE LADDER: ordered stops with live buses interleaved",
             "params": {"route": "route_id (required)", "direction": "0|1 (default: both)"}},
        ],
        "archive": _archive_meta(),
        "coverage": _coverage_stamp(),
    })
