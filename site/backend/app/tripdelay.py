"""MTA's OWN schedule deviation — `TripUpdate.delay`, per trip, live.

Why this module exists
----------------------
The bus `tripUpdates` feed carries a **trip-level** `delay` field: the agency's own
seconds-early/late figure for the trip, published at 100% coverage (1,383/1,383 on the
2026-07-25 reference capture). Every adherence number this platform showed before today
was *our reconstruction* against GTFS static. This is MTA's number, and it is free.

It is deliberately NOT the same statistic as the derived `headway_deviation`:

  * `TripUpdate.delay`  — how late THIS TRIP is against ITS OWN schedule, right now,
    according to the agency. One number per running trip. No archive depth involved.
  * derived adherence   — our reconstruction over the observed archive, depth-limited.

They can disagree and both be right. Never present one as the other; every payload here
carries `basis: "mta_tripupdate_delay"` so a consumer cannot mistake it.

Sources, in order
-----------------
1. The poller's `bus_trip_updates` Parquet archive (column `trip_delay`, written since
   2026-07-25). Freshest row per trip_id in the newest hour partition.
2. A direct cached GTFS-RT `tripUpdates` fetch with the server-side key — the path the
   public box actually uses, because the raw archive is not synced there.

Both paths report `source` and `stale` honestly, and NEITHER ever invents a value: a trip
with no published delay is absent from the map, and absence is reported as a count.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any

import duckdb

from . import config

# Same vendor-decoder resolution realtime.py uses (kept independent so a failure here
# cannot degrade the vehicle path).
sys.path.insert(0, str(config.REALTIME_PKG_DIR))

# BusTime tripUpdates. config.py owns the vehicles/alerts URLs; this is the third of the
# same family and is env-overridable like the rest.
GTFSRT_TRIPS_URL = os.environ.get(
    "NYCV_GTFSRT_TRIPS_URL", "https://gtfsrt.prod.obanyc.com/tripUpdates"
)
# BusTime's own tripUpdates cadence is 60 s (the poller fetches it at 62 s), so a 45 s
# cache is inside the publication rate and well inside any rate concern.
TRIPDELAY_TTL_S = float(os.environ.get("NYCV_TRIPDELAY_TTL_S", "45"))
# A delay set older than this is reported stale (surfaced, never hidden).
TRIPDELAY_STALE_AFTER_S = float(os.environ.get("NYCV_TRIPDELAY_STALE_AFTER_S", "300"))
# Very late trips are real but drag every mean; the published summary is median-based and
# additionally reports the share beyond this threshold rather than trimming silently.
VERY_LATE_S = int(os.environ.get("NYCV_TRIPDELAY_VERY_LATE_S", "600"))

BASIS = "mta_tripupdate_delay"
BASIS_NOTE = (
    "MTA's own trip-level schedule deviation, read from GTFS-RT TripUpdate.delay on the "
    "bus tripUpdates feed. Positive is LATE, negative is EARLY, in seconds against the "
    "agency's own schedule for that trip. This is NOT this platform's reconstructed "
    "adherence statistic and the two are not interchangeable."
)
ABSENT_NOTE = (
    "A trip with no published delay is absent from this map rather than defaulted to 0. "
    "`trips_without_delay` counts them so a blank can never read as 'on time'."
)

_cache: dict[str, Any] = {"ts": 0.0, "data": None}


def _pctile(sorted_vals: list[int], q: float) -> int | None:
    if not sorted_vals:
        return None
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    pos = q * (len(sorted_vals) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = pos - lo
    return int(round(sorted_vals[lo] * (1.0 - frac) + sorted_vals[hi] * frac))


def _summarise(delays: dict[str, int], as_of: int | None, source: str,
               n_trips_seen: int) -> dict[str, Any]:
    vals = sorted(delays.values())
    n = len(vals)
    late = sum(1 for v in vals if v > 0)
    very_late = sum(1 for v in vals if v > VERY_LATE_S)
    early = sum(1 for v in vals if v < 0)
    stale = as_of is not None and (time.time() - as_of) > TRIPDELAY_STALE_AFTER_S
    return {
        "as_of": as_of,
        "age_s": (int(time.time() - as_of) if as_of else None),
        "source": source,
        "stale": bool(stale),
        "basis": BASIS,
        "basis_note": BASIS_NOTE,
        "absent_note": ABSENT_NOTE,
        "trips_with_delay": n,
        "trips_seen": n_trips_seen,
        "trips_without_delay": max(0, n_trips_seen - n),
        "coverage_pct": (round(100.0 * n / n_trips_seen, 1) if n_trips_seen else None),
        "median_delay_s": _pctile(vals, 0.5),
        "median_delay_min": (round(_pctile(vals, 0.5) / 60.0, 1) if n else None),
        "p10_delay_s": _pctile(vals, 0.10),
        "p90_delay_s": _pctile(vals, 0.90),
        "min_delay_s": (vals[0] if n else None),
        "max_delay_s": (vals[-1] if n else None),
        "share_late": (round(late / n, 2) if n else None),
        "share_early": (round(early / n, 2) if n else None),
        "share_more_than_10_min_late": (round(very_late / n, 2) if n else None),
        "very_late_threshold_s": VERY_LATE_S,
    }


def _from_archive() -> dict[str, Any] | None:
    base = config.REALTIME_ARCHIVE / "bus_trip_updates"
    if not base.exists():
        return None
    files: list[str] = []
    for d in sorted(base.glob("date=*"), reverse=True):
        for h in sorted(d.glob("hour=*"), reverse=True):
            got = list(h.glob("*.parquet"))
            if got:
                files = [p.as_posix() for p in got]
                break
        if files:
            break
    if not files:
        return None
    lst = ",".join("'" + f + "'" for f in files)
    con = duckdb.connect()
    try:
        src = f"read_parquet([{lst}], union_by_name=true)"
        try:
            have = {c[0] for c in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
        except Exception:
            return None
        if "trip_delay" not in have:
            # Partitions written before 2026-07-25 have no such column. Say so; do not
            # fall through to a reconstructed number wearing MTA's label.
            return None
        rows = con.execute(
            f"""
            WITH t AS (SELECT * FROM {src}),
                 m AS (SELECT max(poll_ts) AS mx FROM t),
                 r AS (SELECT trip_id, route_id, vehicle_id, trip_delay, poll_ts,
                              row_number() OVER (PARTITION BY trip_id
                                                 ORDER BY poll_ts DESC) AS rn
                       FROM t, m WHERE t.poll_ts >= m.mx - 180 AND t.trip_id IS NOT NULL)
            SELECT trip_id, route_id, vehicle_id, trip_delay, (SELECT mx FROM m)
            FROM r WHERE rn = 1
            """
        ).fetchall()
    finally:
        con.close()
    if not rows:
        return None
    as_of = int(rows[0][4]) if rows[0][4] is not None else None
    delays: dict[str, int] = {}
    by_route: dict[str, list[int]] = {}
    by_vehicle: dict[str, int] = {}
    for trip_id, route_id, vehicle_id, d, _mx in rows:
        if d is None:
            continue
        delays[str(trip_id)] = int(d)
        if route_id:
            by_route.setdefault(str(route_id), []).append(int(d))
        if vehicle_id:
            by_vehicle[str(vehicle_id)] = int(d)
    out = _summarise(delays, as_of, "archive", len(rows))
    out["by_trip"] = delays
    out["by_vehicle"] = by_vehicle
    out["_by_route_raw"] = by_route
    return out


def _from_live() -> dict[str, Any] | None:
    if not config.MTA_BUSTIME_KEY:
        return None
    try:
        import httpx
        from google.transit import gtfs_realtime_pb2  # type: ignore

        r = httpx.get(GTFSRT_TRIPS_URL, params={"key": config.MTA_BUSTIME_KEY}, timeout=25.0)
        r.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(r.content)
    except Exception:
        return None
    as_of = int(feed.header.timestamp) if feed.header.timestamp else int(time.time())
    delays: dict[str, int] = {}
    by_route: dict[str, list[int]] = {}
    by_vehicle: dict[str, int] = {}
    seen = 0
    for ent in feed.entity:
        if not ent.HasField("trip_update"):
            continue
        seen += 1
        tu = ent.trip_update
        if not tu.HasField("delay"):
            continue
        d = int(tu.delay)
        tid = tu.trip.trip_id or None
        if tid:
            delays[tid] = d
        rid = tu.trip.route_id or None
        if rid:
            by_route.setdefault(rid, []).append(d)
        vid = tu.vehicle.id or None
        if vid:
            by_vehicle[vid] = d
    if not delays:
        return None
    out = _summarise(delays, as_of, "live", seen)
    out["by_trip"] = delays
    out["by_vehicle"] = by_vehicle
    out["_by_route_raw"] = by_route
    return out


def get_trip_delays() -> dict[str, Any]:
    """Freshest trip-level delays. Archive first, live GTFS-RT fallback.

    Cached for TRIPDELAY_TTL_S so N concurrent readers cost one upstream read.
    """
    now = time.time()
    if _cache["data"] is not None and (now - _cache["ts"]) < TRIPDELAY_TTL_S:
        return _cache["data"]
    data = _from_archive()
    if data is None or data.get("stale"):
        live = _from_live()
        if live is not None:
            data = live
    if data is None:
        data = {
            "as_of": None, "age_s": None, "source": "none", "stale": True,
            "basis": BASIS, "basis_note": BASIS_NOTE, "absent_note": ABSENT_NOTE,
            "trips_with_delay": 0, "trips_seen": 0, "trips_without_delay": 0,
            "coverage_pct": None, "median_delay_s": None, "median_delay_min": None,
            "p10_delay_s": None, "p90_delay_s": None, "min_delay_s": None,
            "max_delay_s": None, "share_late": None, "share_early": None,
            "share_more_than_10_min_late": None, "very_late_threshold_s": VERY_LATE_S,
            "by_trip": {}, "by_vehicle": {}, "_by_route_raw": {},
            "unavailable_reason": (
                "No bus_trip_updates partition carries a trip_delay column and no live "
                "tripUpdates fetch succeeded. No delay figure is shown rather than a "
                "reconstructed one wearing MTA's label."
            ),
        }
    _cache["ts"] = now
    _cache["data"] = data
    return data


def _median(vals: list[int]) -> int | None:
    if not vals:
        return None
    s = sorted(vals)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else int(round((s[mid - 1] + s[mid]) / 2.0))


def summary(top_n: int = 10) -> dict[str, Any]:
    """The fleet-wide picture, with the routes running latest right now.

    Routes are ranked only among those with enough running trips to be worth naming; the
    minimum is published in the payload rather than assumed.
    """
    min_trips = int(os.environ.get("NYCV_TRIPDELAY_MIN_ROUTE_TRIPS", "5"))
    d = get_trip_delays()
    by_route = d.get("_by_route_raw") or {}
    rows = []
    for rid, vals in by_route.items():
        if len(vals) < min_trips:
            continue
        med = _median(vals)
        rows.append({
            "route_id": rid, "n_trips": len(vals),
            "median_delay_s": med,
            "median_delay_min": (round(med / 60.0, 1) if med is not None else None),
            "share_late": round(sum(1 for v in vals if v > 0) / len(vals), 2),
        })
    rows.sort(key=lambda r: -(r["median_delay_s"] or 0))
    out = {k: v for k, v in d.items()
           if k not in ("by_trip", "by_vehicle", "_by_route_raw")}
    out["route_ranking_rule"] = (
        f"Routes with at least {min_trips} running trips carrying a published delay, "
        f"ranked by the MEDIAN of those trips' delays. Routes below that trip count are "
        f"omitted rather than ranked on one or two buses."
    )
    out["min_route_trips"] = min_trips
    out["routes_ranked"] = len(rows)
    out["latest_routes"] = rows[:top_n]
    out["earliest_routes"] = rows[::-1][:top_n]
    return out
