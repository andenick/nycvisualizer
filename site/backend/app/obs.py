"""Bus Observatory (S5) — route dossier, Marey diagram data, headways, league tables.

A self-contained APIRouter (`/api/obs/*`) mounted by main.py with a single include line.
Everything reads:

  * derive2 hourly-refreshed outputs   config.DERIVED_ROOT/{trajectories,observed_headways}/date=*/
  * derive2 GTFS static cache          config.DERIVE2_CACHE/{trip_meta,stop_offsets,
                                        scheduled_stop_times,stops,shape_points_2263,
                                        calendar,calendar_dates}.parquet
  * bus analysis outputs               config.BUS_OUTPUTS_DIR/*.parquet  (ridership, segment
                                        speeds, scheduled headways, trips/hour)
  * dossier precompute                 config.OBS_PRECOMPUTE_DIR/{route_hourly_ridership,
                                        route_ace,route_ace_by_year}.parquet  (05_obs_precompute.py)
  * SAI                                config.SAI_DIR/sai_scores.parquet
  * live vehicle positions             app.realtime.get_vehicles / get_alerts
  * GTFS route catalog                 app.gtfs.get_route_catalog

Design notes
------------
* All DuckDB queries run over Parquet with explicit date/route pruning (a fresh in-memory
  connection per query, same pattern as gtfs.py). No request touches the 5.4 GB jane_geo DB
  — its two slow aggregates (ridership-by-hour, ACE counts) are precomputed to tiny Parquets.
* NYC is EDT (UTC-4) for the whole archive window; local seconds = utc_epoch + NYC_UTC_OFFSET_S
  (= utc - 14400). Marey/headway buckets are local, matching derive2.
* Every reliability response carries {archive_depth_days, preliminary (depth<14), gap_note}.
* Marey y-axis is distance-along-shape in feet (offset_ft) on the route+direction's *canonical*
  (most-used) shape; observed trajectories are already 30 s-resampled by derive2 and are thinned
  to ~60 s here to cap payload; scheduled "ghost" trips come from GTFS stop_times projected onto
  stop offsets; for a window ending now the freshest live vehicle positions are merged in.
"""
from __future__ import annotations

import calendar as _cal
import json
import time
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

import duckdb
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from . import config, gtfs, realtime

router = APIRouter(prefix="/api/obs", tags=["observatory"])

# The known poller-suspension gap (see derive2 METHODS §5). Surfaced in gap_note.
_GAP_NOTE = (
    "Poller archiving was suspended 2026-07-21 00:51–22:55 ET (disk guard); that day's "
    "hours 01–21 are excluded from observed stats. History deepens daily."
)


# --------------------------------------------------------------------------- #
# time helpers (EDT, fixed offset — no DST transition in the archive window)
# --------------------------------------------------------------------------- #
def _local_midnight_utc(date_str: str) -> int:
    """UTC epoch of `date_str` 00:00 local (EDT)."""
    y, m, d = (int(x) for x in date_str.split("-"))
    return _cal.timegm((y, m, d, 0, 0, 0, 0, 0, 0)) - config.NYC_UTC_OFFSET_S


def _today_local() -> str:
    now = int(time.time())
    return datetime.fromtimestamp(now + config.NYC_UTC_OFFSET_S, tz=timezone.utc).date().isoformat()


# --------------------------------------------------------------------------- #
# DuckDB plumbing
# --------------------------------------------------------------------------- #
def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("PRAGMA threads=4")
    return con


def _plist(paths: list[str]) -> str:
    return "[" + ",".join("'" + p.replace("'", "''") + "'" for p in paths) + "]"


def _part_files(dataset: str, dates: list[str], stem: str = "*") -> list[str]:
    base = config.DERIVED_ROOT / dataset
    out: list[str] = []
    for d in dates:
        pdir = base / f"date={d}"
        if not pdir.exists():
            continue
        for f in sorted(pdir.glob(f"{stem}.parquet")):
            out.append(f.as_posix())
    return out


def _cache_file(name: str) -> str:
    return (config.DERIVE2_CACHE / f"{name}.parquet").as_posix()


def _bus_file(name: str) -> str:
    return (config.BUS_OUTPUTS_DIR / f"{name}.parquet").as_posix()


def _obs_file(name: str) -> str:
    return (config.OBS_PRECOMPUTE_DIR / f"{name}.parquet").as_posix()


# --------------------------------------------------------------------------- #
# archive-depth metadata (mtime-cached list of observed service days)
# --------------------------------------------------------------------------- #
def _observed_dates_sig() -> tuple:
    base = config.DERIVED_ROOT / "observed_headways"
    if not base.exists():
        return ()
    return tuple(sorted(p.name for p in base.glob("date=*")))


@lru_cache(maxsize=4)
def _observed_dates_cached(_sig: tuple) -> list[str]:
    return sorted(d.split("=", 1)[1] for d in _sig)


def _observed_dates() -> list[str]:
    return _observed_dates_cached(_observed_dates_sig())


def _archive_meta(dates_used: list[str] | None = None) -> dict[str, Any]:
    dates = _observed_dates()
    depth = len(dates)
    return {
        "archive_depth_days": depth,
        "preliminary": depth < 14,
        "gap_note": _GAP_NOTE,
        "observed_dates": dates,
        "dates_used": dates_used if dates_used is not None else dates,
    }


# --------------------------------------------------------------------------- #
# tiny TTL cache
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
# route metadata (SBS flag, borough group) — layered on the GTFS catalog
# --------------------------------------------------------------------------- #
def _is_sbs(route_id: str, short_name: str) -> bool:
    return route_id.endswith("+") or "SBS" in (short_name or "").upper()


def _route_meta(route_id: str) -> dict[str, Any]:
    for r in gtfs.get_route_catalog():
        if r["route_id"] == route_id:
            return {
                "route_id": route_id,
                "short_name": r.get("short_name") or route_id,
                "long_name": r.get("long_name") or "",
                "borough": r.get("borough") or "",
                "color": r.get("color") or "2563eb",
                "sbs": _is_sbs(route_id, r.get("short_name") or ""),
            }
    return {
        "route_id": route_id,
        "short_name": route_id,
        "long_name": "",
        "borough": "",
        "color": "2563eb",
        "sbs": _is_sbs(route_id, route_id),
    }


# --------------------------------------------------------------------------- #
# 1) /api/obs/routes
# --------------------------------------------------------------------------- #
def _routes_payload() -> dict[str, Any]:
    cat = gtfs.get_route_catalog()
    dates = _observed_dates()
    latest = dates[-1] if dates else None
    stats: dict[str, dict] = {}
    if latest:
        files = _part_files("observed_headways", [latest], stem="part-000")
        if files:
            con = _con()
            try:
                rows = con.execute(
                    f"""
                    SELECT route_id,
                           median(median_headway_s)      AS med_hw_s,
                           avg(bunching_index)           AS bunching_index,
                           avg(sched_median_headway_s)   AS sched_med_hw_s,
                           sum(n_headways)               AS n_headways,
                           count(DISTINCT stop_id)       AS n_stops,
                           count(DISTINCT local_hour)    AS coverage_hours,
                           bool_or(preliminary)          AS preliminary
                    FROM read_parquet({_plist(files)})
                    GROUP BY 1
                    """
                ).fetchall()
            finally:
                con.close()
            for r in rows:
                stats[r[0]] = {
                    "date": latest,
                    "median_headway_s": r[1],
                    "median_headway_min": round(r[1] / 60.0, 1) if r[1] is not None else None,
                    "bunching_index": round(r[2], 3) if r[2] is not None else None,
                    "sched_median_headway_min": round(r[3] / 60.0, 1) if r[3] is not None else None,
                    "n_headways": int(r[4]) if r[4] is not None else 0,
                    "n_stops_observed": int(r[5]) if r[5] is not None else 0,
                    "coverage_hours": int(r[6]) if r[6] is not None else 0,
                    "preliminary": bool(r[7]),
                }
    out_routes = []
    for r in cat:
        rid = r["route_id"]
        out_routes.append(
            {
                "route_id": rid,
                "short_name": r.get("short_name") or rid,
                "long_name": r.get("long_name") or "",
                "borough": r.get("borough") or "",
                "borough_group": r.get("borough") or "",
                "color": r.get("color") or "2563eb",
                "sbs": _is_sbs(rid, r.get("short_name") or ""),
                "observed": rid in stats,
                "stats": stats.get(rid),
            }
        )
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(out_routes),
        "observed_count": len(stats),
        "archive": _archive_meta(),
        "routes": out_routes,
    }


@router.get("/routes")
async def obs_routes() -> JSONResponse:
    data = _cached("routes", 600, _routes_payload)
    return JSONResponse(data)


# --------------------------------------------------------------------------- #
# 2) /api/obs/marey
# --------------------------------------------------------------------------- #
def _canonical_shape(con, route_id: str, direction: int) -> str | None:
    row = con.execute(
        f"""
        SELECT shape_id, count(*) AS n
        FROM read_parquet('{_cache_file("trip_meta")}')
        WHERE route_id = ? AND direction_id = ? AND shape_id IS NOT NULL AND shape_id <> ''
        GROUP BY shape_id ORDER BY n DESC LIMIT 1
        """,
        [route_id, direction],
    ).fetchone()
    return row[0] if row else None


def _shape_length_ft(con, shape_id: str) -> float | None:
    row = con.execute(
        f"""
        WITH s AS (
            SELECT x_ft, y_ft, seq FROM read_parquet('{_cache_file("shape_points_2263")}')
            WHERE shape_id = ? ORDER BY seq
        ), d AS (
            SELECT sqrt(power(x_ft - lag(x_ft) OVER (ORDER BY seq), 2)
                      + power(y_ft - lag(y_ft) OVER (ORDER BY seq), 2)) AS dd FROM s
        )
        SELECT sum(dd) FROM d
        """,
        [shape_id],
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def _stop_gridlines(con, shape_id: str) -> list[dict]:
    rows = con.execute(
        f"""
        SELECT so.stop_id, s.stop_name, so.stop_offset_ft, so.stop_seq
        FROM read_parquet('{_cache_file("stop_offsets")}') so
        LEFT JOIN read_parquet('{_cache_file("stops")}') s ON s.stop_id = so.stop_id
        WHERE so.shape_id = ?
        ORDER BY so.stop_offset_ft
        """,
        [shape_id],
    ).fetchall()
    return [
        {"stop_id": r[0], "name": r[1] or r[0], "offset_ft": round(r[2], 1), "stop_seq": r[3]}
        for r in rows
    ]


def _active_service_ids(con, date_str: str) -> list[str]:
    yyyymmdd = date_str.replace("-", "")
    dow = datetime.strptime(date_str, "%Y-%m-%d").weekday()  # Mon=0
    col = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"][dow]
    base = {
        r[0]
        for r in con.execute(
            f"""
            SELECT service_id FROM read_parquet('{_cache_file("calendar")}')
            WHERE {col} = '1' AND start_date <= ? AND end_date >= ?
            """,
            [yyyymmdd, yyyymmdd],
        ).fetchall()
    }
    added, removed = set(), set()
    for sid, ex in con.execute(
        f"""
        SELECT service_id, exception_type FROM read_parquet('{_cache_file("calendar_dates")}')
        WHERE date = ?
        """,
        [yyyymmdd],
    ).fetchall():
        (added if str(ex) == "1" else removed).add(sid)
    return sorted((base | added) - removed)


def _thin_series(points: list[tuple[int, float]], min_gap_s: int = 60) -> list[list]:
    """points sorted by ts -> keep ~min_gap_s spacing, always keep last."""
    out: list[list] = []
    last_ts = None
    for ts, off in points:
        if last_ts is None or (ts - last_ts) >= min_gap_s:
            out.append([int(ts), round(float(off), 1)])
            last_ts = ts
    if points and (not out or out[-1][0] != int(points[-1][0])):
        out.append([int(points[-1][0]), round(float(points[-1][1]), 1)])
    return out


def _live_points(route_id: str, direction: int, offset_by_stop: dict[str, float]) -> tuple[list[dict], int | None]:
    """Freshest live vehicle positions for the route, placed at their next stop's offset."""
    try:
        veh = realtime.get_vehicles()
    except Exception:
        return [], None
    as_of = veh.get("as_of")
    pts = []
    for v in veh.get("vehicles", []):
        if v.get("route_id") != route_id:
            continue
        if direction is not None and v.get("direction_id") not in (None, direction):
            continue
        sid = v.get("stop_id")
        off = offset_by_stop.get(str(sid)) if sid is not None else None
        if off is None:
            continue
        ts = v.get("timestamp") or as_of
        if ts is None:
            continue
        pts.append({"trip_id": v.get("trip_id"), "vehicle_id": v.get("vehicle_id"), "ts": int(ts), "offset_ft": round(off, 1)})
    return pts, as_of


def _marey_payload(route_id: str, direction: int, window: str, date_str: str, end: int | None) -> dict[str, Any]:
    t0 = time.time()
    con = _con()
    try:
        shape_id = _canonical_shape(con, route_id, direction)
        if shape_id is None:
            return {"error": f"no GTFS shape for route {route_id} direction {direction}", "route": route_id}
        gridlines = _stop_gridlines(con, shape_id)
        shape_len = _shape_length_ft(con, shape_id)
        offset_by_stop = {g["stop_id"]: g["offset_ft"] for g in gridlines}

        today = _today_local()
        is_today = date_str == today
        now = int(time.time())
        mid = _local_midnight_utc(date_str)

        # resolve window [start, end]
        if end is not None:
            end_ts = int(end)
        elif is_today:
            end_ts = now
        else:
            r = con.execute(
                f"SELECT max(ts) FROM read_parquet({_plist(_part_files('trajectories', [date_str]))}) WHERE route_id = ?",
                [route_id],
            ).fetchone()
            end_ts = int(r[0]) if r and r[0] is not None else mid + 24 * 3600
        if window == "today":
            start_ts = mid
        else:
            hours = 6 if window == "6h" else 3
            start_ts = end_ts - hours * 3600

        # --- observed trajectories (archive, 30s-resampled) ------------------
        traj_files = _part_files("trajectories", sorted({date_str}))
        observed: list[dict] = []
        if traj_files:
            rows = con.execute(
                f"""
                SELECT trip_id, shape_id, ts, offset_ft
                FROM read_parquet({_plist(traj_files)})
                WHERE route_id = ? AND direction_id = ? AND ts BETWEEN ? AND ?
                ORDER BY trip_id, ts
                """,
                [route_id, direction, start_ts, end_ts],
            ).fetchall()
            by_trip: dict[str, dict] = {}
            for trip_id, shp, ts, off in rows:
                d = by_trip.setdefault(trip_id, {"shape_id": shp, "pts": []})
                d["pts"].append((ts, off))
            for trip_id, d in by_trip.items():
                pts = d["pts"]
                last_ts = pts[-1][0] if pts else 0
                observed.append(
                    {
                        "trip_id": trip_id,
                        "shape_id": d["shape_id"],
                        "live": bool(is_today and (now - last_ts) <= config.STALE_AFTER_S),
                        "series": _thin_series(pts, 60),
                    }
                )
            observed.sort(key=lambda t: t["series"][0][0] if t["series"] else 0)

        # --- live merge (window ending ~now) ---------------------------------
        live_merged = False
        live_vehicles = 0
        if is_today and end_ts >= now - config.STALE_AFTER_S:
            live_pts, as_of = _live_points(route_id, direction, offset_by_stop)
            if live_pts:
                live_merged = True
                idx = {o["trip_id"]: o for o in observed if o["trip_id"]}
                for lp in live_pts:
                    live_vehicles += 1
                    tgt = idx.get(lp["trip_id"])
                    pt = [lp["ts"], lp["offset_ft"]]
                    if tgt is not None:
                        if not tgt["series"] or tgt["series"][-1][0] < lp["ts"]:
                            tgt["series"].append(pt)
                        tgt["live"] = True
                    else:
                        newt = {"trip_id": lp["trip_id"], "shape_id": shape_id, "live": True, "series": [pt]}
                        observed.append(newt)
                        idx[lp["trip_id"]] = newt

        # --- scheduled ghost trips -------------------------------------------
        services = _active_service_ids(con, date_str)
        scheduled: list[dict] = []
        if services:
            svc_in = "(" + ",".join("'" + s.replace("'", "''") + "'" for s in services) + ")"
            # trips for this route+direction active today, with their own shape's stop offsets
            rows = con.execute(
                f"""
                WITH trips AS (
                    SELECT trip_id, shape_id FROM read_parquet('{_cache_file("trip_meta")}')
                    WHERE route_id = ? AND direction_id = ? AND service_id IN {svc_in}
                )
                SELECT st.trip_id, sst.sched_arr_sec, so.stop_offset_ft
                FROM trips st
                JOIN read_parquet('{_cache_file("scheduled_stop_times")}') sst ON sst.trip_id = st.trip_id
                JOIN read_parquet('{_cache_file("stop_offsets")}') so
                     ON so.shape_id = st.shape_id AND so.stop_id = sst.stop_id
                ORDER BY st.trip_id, sst.stop_seq
                """,
                [route_id, direction],
            ).fetchall()
            by_trip_s: dict[str, list] = {}
            for trip_id, sec, off in rows:
                ts = mid + int(sec)
                if start_ts <= ts <= end_ts:
                    by_trip_s.setdefault(trip_id, []).append([ts, round(float(off), 1)])
            for trip_id, series in by_trip_s.items():
                if len(series) >= 2:
                    scheduled.append({"trip_id": trip_id, "series": series})
            scheduled.sort(key=lambda t: t["series"][0][0])

        points_total = sum(len(o["series"]) for o in observed) + sum(len(s["series"]) for s in scheduled)
        return {
            "route": route_id,
            "direction": direction,
            "date": date_str,
            "window": window,
            "window_start_ts": start_ts,
            "window_end_ts": end_ts,
            "is_today": is_today,
            "live_merged": live_merged,
            "canonical_shape_id": shape_id,
            "shape_length_ft": round(shape_len, 1) if shape_len else None,
            "stops": gridlines,
            "observed": observed,
            "scheduled": scheduled,
            "counts": {
                "observed_trips": len(observed),
                "scheduled_trips": len(scheduled),
                "live_vehicles": live_vehicles,
                "points_total": points_total,
                "stops": len(gridlines),
            },
            "archive": _archive_meta([date_str]),
            "elapsed_ms": round((time.time() - t0) * 1000, 1),
        }
    finally:
        con.close()


@router.get("/marey")
async def obs_marey(
    route: str,
    direction: int = 0,
    window: str = "3h",
    date: str | None = None,
    end: int | None = None,
) -> JSONResponse:
    date_str = date or _today_local()
    if window not in ("3h", "6h", "today"):
        window = "3h"
    # 30s cache per (route, dir, window, date, end-bucket)
    ekey = "now" if end is None else str(end // 30)
    key = f"marey|{route}|{direction}|{window}|{date_str}|{ekey}"
    data = _cached(key, 30, lambda: _marey_payload(route, direction, window, date_str, end))
    return JSONResponse(data)


# --------------------------------------------------------------------------- #
# 3) /api/obs/marey/stream — SSE incremental live points (~30s)
# --------------------------------------------------------------------------- #
@router.get("/marey/stream")
async def obs_marey_stream(request: Request, route: str, direction: int = 0) -> StreamingResponse:
    # resolve the canonical shape + stop offsets once, up front
    con = _con()
    try:
        shape_id = _canonical_shape(con, route, direction)
        offset_by_stop = (
            {g["stop_id"]: g["offset_ft"] for g in _stop_gridlines(con, shape_id)} if shape_id else {}
        )
    finally:
        con.close()

    import asyncio

    async def gen():
        while True:
            if await request.is_disconnected():
                break
            try:
                pts, as_of = await asyncio.to_thread(_live_points, route, direction, offset_by_stop)
                payload = {"route": route, "direction": direction, "as_of": as_of, "count": len(pts), "points": pts}
                yield f"data: {json.dumps(payload)}\n\n"
            except Exception:
                yield "event: error\ndata: {}\n\n"
            await asyncio.sleep(config.SSE_INTERVAL_S)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- #
# 4) /api/obs/headways  +  /api/obs/headways/summary
# --------------------------------------------------------------------------- #
def _parse_date_range(date_range: str | None) -> list[str]:
    dates = _observed_dates()
    if not date_range:
        return dates
    parts = [p.strip() for p in date_range.split(",") if p.strip()]
    if len(parts) == 1:
        return [d for d in dates if d == parts[0]]
    lo, hi = parts[0], parts[1]
    return [d for d in dates if lo <= d <= hi]


def _headways_payload(route_id: str, stop_id: str | None, date_range: str | None) -> dict[str, Any]:
    dates = _parse_date_range(date_range)
    files = _part_files("observed_headways", dates, stem="part-000")
    if not files:
        return {"route": route_id, "stop_id": stop_id, "series": [], "archive": _archive_meta(dates)}
    con = _con()
    try:
        if stop_id:
            rows = con.execute(
                f"""
                SELECT local_date, local_hour, direction_id, stop_id, any_value(stop_name),
                       median_headway_s, sched_median_headway_s, headway_deviation_s,
                       bunching_index, headway_cv, bunch_share_lt50_sched, n_headways, preliminary
                FROM read_parquet({_plist(files)})
                WHERE route_id = ? AND stop_id = ?
                GROUP BY local_date, local_hour, direction_id, stop_id, median_headway_s,
                         sched_median_headway_s, headway_deviation_s, bunching_index, headway_cv,
                         bunch_share_lt50_sched, n_headways, preliminary
                ORDER BY local_date, local_hour, direction_id
                """,
                [route_id, stop_id],
            ).fetchall()
            series = [
                {
                    "date": r[0], "local_hour": r[1], "direction_id": r[2], "stop_id": r[3], "stop_name": r[4],
                    "median_headway_s": r[5], "sched_median_headway_s": r[6], "headway_deviation_s": r[7],
                    "bunching_index": round(r[8], 3) if r[8] is not None else None,
                    "headway_cv": round(r[9], 3) if r[9] is not None else None,
                    "bunch_share_lt50_sched": round(r[10], 3) if r[10] is not None else None,
                    "n_headways": int(r[11]) if r[11] is not None else 0, "preliminary": bool(r[12]),
                }
                for r in rows
            ]
        else:
            rows = con.execute(
                f"""
                SELECT local_date, local_hour,
                       median(median_headway_s)     AS med_hw,
                       median(sched_median_headway_s) AS sched_hw,
                       avg(bunching_index)          AS bi,
                       sum(n_headways)              AS nh,
                       count(DISTINCT stop_id)      AS nstops,
                       bool_or(preliminary)         AS prelim
                FROM read_parquet({_plist(files)})
                WHERE route_id = ?
                GROUP BY local_date, local_hour
                ORDER BY local_date, local_hour
                """,
                [route_id],
            ).fetchall()
            series = [
                {
                    "date": r[0], "local_hour": r[1],
                    "median_headway_s": r[2], "sched_median_headway_s": r[3],
                    "headway_deviation_s": (r[2] - r[3]) if (r[2] is not None and r[3] is not None) else None,
                    "bunching_index": round(r[4], 3) if r[4] is not None else None,
                    "n_headways": int(r[5]) if r[5] is not None else 0,
                    "n_stops": int(r[6]) if r[6] is not None else 0, "preliminary": bool(r[7]),
                }
                for r in rows
            ]
    finally:
        con.close()
    return {
        "route": route_id, "stop_id": stop_id, "date_range": date_range,
        "grain": "stop_hour" if stop_id else "route_hour",
        "n_points": len(series), "series": series, "archive": _archive_meta(dates),
    }


@router.get("/headways")
async def obs_headways(route: str, stop_id: str | None = None, date_range: str | None = None) -> JSONResponse:
    key = f"hw|{route}|{stop_id}|{date_range}"
    data = _cached(key, 600, lambda: _headways_payload(route, stop_id, date_range))
    return JSONResponse(data)


def _headways_summary_payload(route_id: str, direction: int | None) -> dict[str, Any]:
    dates = _observed_dates()
    files = _part_files("observed_headways", dates, stem="part-000")
    if not files:
        return {"route": route_id, "stops": [], "archive": _archive_meta(dates)}
    con = _con()
    try:
        # canonical shape offset for ordering the strip; fall back to no offset
        shp = _canonical_shape(con, route_id, direction if direction is not None else 0)
        offmap: dict[str, float] = {}
        if shp:
            offmap = {g["stop_id"]: g["offset_ft"] for g in _stop_gridlines(con, shp)}
        dir_clause = "" if direction is None else "AND direction_id = ?"
        params: list[Any] = [route_id] + ([] if direction is None else [direction])
        rows = con.execute(
            f"""
            SELECT stop_id, direction_id, any_value(stop_name)   AS stop_name,
                   median(median_headway_s)                      AS med_hw,
                   median(sched_median_headway_s)                AS sched_hw,
                   avg(bunching_index)                           AS bi,
                   max(headway_cv)                               AS max_cv,
                   sum(n_headways)                               AS nh,
                   count(DISTINCT local_date)                    AS obs_days,
                   bool_or(preliminary)                          AS prelim
            FROM read_parquet({_plist(files)})
            WHERE route_id = ? {dir_clause}
            GROUP BY stop_id, direction_id
            """,
            params,
        ).fetchall()
    finally:
        con.close()
    stops = []
    for r in rows:
        stops.append(
            {
                "stop_id": r[0], "direction_id": r[1], "stop_name": r[2],
                "offset_ft": offmap.get(r[0]),
                "median_headway_s": r[3], "median_headway_min": round(r[3] / 60.0, 1) if r[3] is not None else None,
                "sched_median_headway_s": r[4],
                "sched_median_headway_min": round(r[4] / 60.0, 1) if r[4] is not None else None,
                "bunching_index": round(r[5], 3) if r[5] is not None else None,
                "max_headway_cv": round(r[6], 3) if r[6] is not None else None,
                "n_headways": int(r[7]) if r[7] is not None else 0,
                "observed_days": int(r[8]) if r[8] is not None else 0,
                "preliminary": bool(r[9]),
            }
        )
    stops.sort(key=lambda s: (s["direction_id"] if s["direction_id"] is not None else 0,
                              s["offset_ft"] if s["offset_ft"] is not None else 1e18))
    return {"route": route_id, "direction": direction, "n_stops": len(stops), "stops": stops, "archive": _archive_meta(dates)}


@router.get("/headways/summary")
async def obs_headways_summary(route: str, direction: int | None = None) -> JSONResponse:
    key = f"hwsum|{route}|{direction}"
    data = _cached(key, 600, lambda: _headways_summary_payload(route, direction))
    return JSONResponse(data)


# --------------------------------------------------------------------------- #
# 5) /api/obs/dossier
# --------------------------------------------------------------------------- #
def _dossier_payload(route_id: str) -> dict[str, Any]:
    t0 = time.time()
    meta = _route_meta(route_id)
    dates = _observed_dates()
    agg_files = _part_files("observed_headways", dates, stem="part-000")
    con = _con()
    try:
        # --- ridership by hour (precompute) ---
        ridership = []
        try:
            rows = con.execute(
                f"SELECT hod, weekday_boardings, weekend_boardings, total_boardings "
                f"FROM read_parquet('{_obs_file('route_hourly_ridership')}') WHERE route = ? ORDER BY hod",
                [route_id],
            ).fetchall()
            ridership = [
                {"hod": r[0], "weekday_boardings": r[1], "weekend_boardings": r[2], "total_boardings": r[3]}
                for r in rows
            ]
        except Exception:
            ridership = []

        # --- slowest segments (bus analysis) ---
        slowest = []
        try:
            rows = con.execute(
                f"""SELECT from_stop, to_stop, wt_speed_mph, n_trips, seg_miles
                    FROM read_parquet('{_bus_file('02_all_segments_peak')}')
                    WHERE route_id = ? ORDER BY wt_speed_mph ASC LIMIT 10""",
                [route_id],
            ).fetchall()
            slowest = [
                {"from_stop": r[0], "to_stop": r[1], "wt_speed_mph": round(r[2], 2),
                 "n_trips": int(r[3]) if r[3] is not None else None, "seg_miles": round(r[4], 3) if r[4] is not None else None}
                for r in rows
            ]
        except Exception:
            slowest = []
        route_speed = None
        try:
            r = con.execute(
                f"SELECT wt_speed_mph, n_trips, borough FROM read_parquet('{_bus_file('02_route_peak_speed')}') WHERE route_id = ?",
                [route_id],
            ).fetchone()
            if r:
                route_speed = {"wt_speed_mph": round(r[0], 2), "n_trips": int(r[1]) if r[1] is not None else None, "borough": r[2]}
        except Exception:
            pass

        # --- ACE violations (precompute) ---
        ace = None
        try:
            r = con.execute(
                f"""SELECT program, implementation_date, violations_total, first_violation, last_violation
                    FROM read_parquet('{_obs_file('route_ace')}') WHERE route = ?""",
                [route_id],
            ).fetchone()
            if r:
                by_year = con.execute(
                    f"SELECT year, violations FROM read_parquet('{_obs_file('route_ace_by_year')}') WHERE route = ? ORDER BY year",
                    [route_id],
                ).fetchall()
                ace = {
                    "ace_enabled": r[0] is not None,
                    "program": r[0],
                    "implementation_date": str(r[1]) if r[1] is not None else None,
                    "violations_total": int(r[2]) if r[2] is not None else 0,
                    "first_violation": str(r[3]) if r[3] is not None else None,
                    "last_violation": str(r[4]) if r[4] is not None else None,
                    "by_year": [{"year": int(y), "violations": int(v)} for y, v in by_year],
                }
        except Exception:
            ace = None

        # --- SAI stats of the route's observed stops ---
        sai = None
        try:
            sai_path = (config.SAI_DIR / "sai_scores.parquet").as_posix()
            if agg_files:
                r = con.execute(
                    f"""
                    WITH rs AS (
                        SELECT DISTINCT CAST(stop_id AS BIGINT) AS sid
                        FROM read_parquet({_plist(agg_files)}) WHERE route_id = ?
                    )
                    SELECT count(*) AS n_stops,
                           median(sai) AS median_sai,
                           100.0 * avg(CASE WHEN shelter_100ft > 0 THEN 1 ELSE 0 END) AS pct_sheltered,
                           median(walkshed_population) AS median_walkshed_pop,
                           median(n_routes) AS median_n_routes,
                           median(safety) AS median_safety, median(comfort) AS median_comfort
                    FROM read_parquet('{sai_path}') sc JOIN rs ON rs.sid = sc.stop_id
                    """,
                    [route_id],
                ).fetchone()
                if r and r[0]:
                    sai = {
                        "n_stops_matched": int(r[0]),
                        "median_composite_sai": round(r[1], 2) if r[1] is not None else None,
                        "pct_sheltered": round(r[2], 1) if r[2] is not None else None,
                        "median_walkshed_population": round(r[3], 0) if r[3] is not None else None,
                        "median_n_routes": r[4], "median_safety": round(r[5], 2) if r[5] is not None else None,
                        "median_comfort": round(r[6], 2) if r[6] is not None else None,
                    }
        except Exception:
            sai = None

        # --- stop spacing (canonical shape) ---
        spacing = None
        try:
            shp = _canonical_shape(con, route_id, 0)
            if shp:
                r = con.execute(
                    f"""
                    WITH o AS (SELECT stop_offset_ft FROM read_parquet('{_cache_file("stop_offsets")}')
                               WHERE shape_id = ? ORDER BY stop_offset_ft),
                         g AS (SELECT stop_offset_ft - lag(stop_offset_ft) OVER (ORDER BY stop_offset_ft) AS gap FROM o)
                    SELECT count(*)+1, median(gap), avg(gap), min(gap), max(gap) FROM g WHERE gap IS NOT NULL
                    """,
                    [shp],
                ).fetchone()
                if r and r[1] is not None:
                    spacing = {
                        "shape_id": shp, "n_stops": int(r[0]),
                        "median_spacing_ft": round(r[1], 1), "mean_spacing_ft": round(r[2], 1),
                        "min_spacing_ft": round(r[3], 1), "max_spacing_ft": round(r[4], 1),
                    }
        except Exception:
            spacing = None

        # --- scheduled service span / frequency by period (bus analysis) ---
        scheduled_service = []
        try:
            rows = con.execute(
                f"""SELECT direction_id, period, span_min, trips, headway_min
                    FROM read_parquet('{_bus_file('03_scheduled_headways_by_period')}')
                    WHERE route = ? ORDER BY direction_id, period""",
                [route_id],
            ).fetchall()
            scheduled_service = [
                {"direction_id": r[0], "period": r[1], "span_min": r[2],
                 "trips": int(r[3]) if r[3] is not None else None, "headway_min": r[4]}
                for r in rows
            ]
        except Exception:
            scheduled_service = []

        # --- reliability summary (from derived aggregate) ---
        reliability = None
        if agg_files:
            r = con.execute(
                f"""
                SELECT median(median_headway_s), median(sched_median_headway_s),
                       avg(bunching_index), median(headway_deviation_s),
                       sum(n_headways), count(DISTINCT stop_id),
                       count(DISTINCT local_date), bool_or(preliminary)
                FROM read_parquet({_plist(agg_files)}) WHERE route_id = ?
                """,
                [route_id],
            ).fetchone()
            if r and r[4]:
                reliability = {
                    "median_headway_s": r[0], "median_headway_min": round(r[0] / 60.0, 1) if r[0] is not None else None,
                    "sched_median_headway_s": r[1],
                    "bunching_index": round(r[2], 3) if r[2] is not None else None,
                    "median_deviation_s": r[3], "n_headways": int(r[4]),
                    "n_stops_observed": int(r[5]), "observed_days": int(r[6]), "preliminary": bool(r[7]),
                }
    finally:
        con.close()

    # --- active alerts ---
    alerts = []
    try:
        al = realtime.get_alerts()
        ru = route_id.upper()
        for a in al.get("alerts", []):
            if any(str(x).upper() == ru for x in a.get("routes", [])):
                alerts.append({"id": a.get("id"), "header": a.get("header"), "description": a.get("description")})
    except Exception:
        alerts = []

    return {
        "route": route_id, "meta": meta, "generated_at": datetime.now(timezone.utc).isoformat(),
        "ridership_by_hour": ridership,
        "route_peak_speed": route_speed,
        "slowest_segments": slowest,
        "ace": ace,
        "sai_stats": sai,
        "stop_spacing": spacing,
        "scheduled_service": scheduled_service,
        "reliability_summary": reliability,
        "alerts_active": alerts,
        "archive": _archive_meta(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/dossier")
async def obs_dossier(route: str) -> JSONResponse:
    data = _cached(f"dossier|{route}", 600, lambda: _dossier_payload(route))
    return JSONResponse(data)


# --------------------------------------------------------------------------- #
# 6) /api/obs/leagues
# --------------------------------------------------------------------------- #
_MIN_OBS_DAYS = 3
_MIN_HEADWAYS = 50


def _leagues_payload() -> dict[str, Any]:
    t0 = time.time()
    dates = _observed_dates()
    files = _part_files("observed_headways", dates, stem="part-000")
    meta_by_route = {r["route_id"]: r for r in gtfs.get_route_catalog()}
    con = _con()
    try:
        reliable_rows, excluded, improved_rows, slowest = [], 0, [], []
        if files:
            rows = con.execute(
                f"""
                SELECT route_id,
                       count(DISTINCT local_date)  AS obs_days,
                       sum(n_headways)             AS n_headways,
                       avg(bunching_index)         AS bunching_index,
                       median(median_headway_s)    AS med_hw,
                       median(headway_deviation_s) AS med_dev,
                       median(abs(headway_deviation_s)) AS med_abs_dev
                FROM read_parquet({_plist(files)})
                GROUP BY route_id
                """
            ).fetchall()
            qualifying = []
            for r in rows:
                obs_days = int(r[1]) if r[1] is not None else 0
                nh = int(r[2]) if r[2] is not None else 0
                if obs_days < _MIN_OBS_DAYS or nh < _MIN_HEADWAYS or r[3] is None:
                    excluded += 1
                    continue
                m = meta_by_route.get(r[0], {})
                qualifying.append(
                    {
                        "route_id": r[0], "short_name": m.get("short_name") or r[0],
                        "borough": m.get("borough") or "", "sbs": _is_sbs(r[0], m.get("short_name") or ""),
                        "observed_days": obs_days, "n_headways": nh,
                        "bunching_index": round(r[3], 3),
                        "median_headway_min": round(r[4] / 60.0, 1) if r[4] is not None else None,
                        "median_deviation_s": round(r[5], 1) if r[5] is not None else None,
                        "median_abs_deviation_s": round(r[6], 1) if r[6] is not None else None,
                    }
                )
            reliable_rows = sorted(qualifying, key=lambda x: x["bunching_index"])

            # most improved vs schedule: first-half vs second-half mean |deviation|
            if len(dates) >= 4:
                half = len(dates) // 2
                early, late = dates[:half], dates[half:]
                ef = _part_files("observed_headways", early, stem="part-000")
                lf = _part_files("observed_headways", late, stem="part-000")
                emap = dict(
                    con.execute(
                        f"SELECT route_id, avg(abs(headway_deviation_s)) FROM read_parquet({_plist(ef)}) GROUP BY 1"
                    ).fetchall()
                )
                lmap = dict(
                    con.execute(
                        f"SELECT route_id, avg(abs(headway_deviation_s)) FROM read_parquet({_plist(lf)}) GROUP BY 1"
                    ).fetchall()
                )
                qset = {q["route_id"] for q in qualifying}
                imp = []
                for rid in qset:
                    e, l = emap.get(rid), lmap.get(rid)
                    if e is None or l is None:
                        continue
                    m = meta_by_route.get(rid, {})
                    imp.append(
                        {"route_id": rid, "short_name": m.get("short_name") or rid, "borough": m.get("borough") or "",
                         "early_abs_dev_s": round(e, 1), "late_abs_dev_s": round(l, 1),
                         "improvement_s": round(e - l, 1)}
                    )
                improved_rows = sorted(imp, key=lambda x: x["improvement_s"], reverse=True)

        # slowest corridors (bus analysis, precomputed)
        try:
            rows = con.execute(
                f"""SELECT route_id, borough, from_stop, to_stop, wt_speed_mph, n_trips, seg_miles
                    FROM read_parquet('{_bus_file('02_slowest_segments_peak')}')
                    ORDER BY wt_speed_mph ASC LIMIT 25"""
            ).fetchall()
            slowest = [
                {"route_id": r[0], "borough": r[1], "from_stop": r[2], "to_stop": r[3],
                 "wt_speed_mph": round(r[4], 2), "n_trips": int(r[5]) if r[5] is not None else None,
                 "seg_miles": round(r[6], 3) if r[6] is not None else None}
                for r in rows
            ]
        except Exception:
            slowest = []
    finally:
        con.close()

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "criteria": {
            "min_observed_days": _MIN_OBS_DAYS, "min_headways": _MIN_HEADWAYS,
            "note": (
                f"Routes with < {_MIN_OBS_DAYS} observed days or < {_MIN_HEADWAYS} total observed "
                "headways are excluded as thin/gap-dominated. Reliability is ranked by bunching_index "
                "(lower = steadier gaps); it is PRELIMINARY until the archive reaches 14-day depth."
            ),
            "excluded_thin_routes": excluded,
            "qualifying_routes": len(reliable_rows),
        },
        "most_reliable": reliable_rows[:15],
        "least_reliable": list(reversed(reliable_rows))[:15],
        "slowest_corridors": slowest,
        "most_improved_vs_schedule": improved_rows[:15],
        "archive": _archive_meta(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/leagues")
async def obs_leagues() -> JSONResponse:
    data = _cached("leagues", 600, _leagues_payload)
    return JSONResponse(data)


# --------------------------------------------------------------------------- #
# 7) /api/obs/ribbon — reliability ribbon (Q1.3): the route's stop-pair segments
#    with geometry + peak weighted speed + within-route speed PERCENTILE.
# --------------------------------------------------------------------------- #
# Data honesty
# ------------
# * geometry  : 02_segment_geometry.parquet (from transit_segment_speeds timepoint
#               endpoints; 100% join to 02_all_segments_peak). Both parquets — this
#               endpoint never touches the 5.4 GB jane_geo DB (obs.py design rule).
# * color     : speed PERCENTILE within the route (Swiftly pattern) — 0 = slowest
#               segment on the route, 1 = fastest; diverging around the route median.
# * WIDTH     : CONSTANT / color-only. Per-segment PASSENGER ridership is NOT
#               derivable — 02_all_segments_peak carries n_trips (bus trip count =
#               service frequency), not APC boardings, and route-level APC cannot be
#               honestly allocated to segments. So we do NOT fake a ridership width;
#               `width_basis` says so and the frontend keeps a constant stroke.
def _ribbon_payload(route_id: str) -> dict[str, Any]:
    t0 = time.time()
    seg_file = _bus_file("02_all_segments_peak")
    geom_file = _bus_file("02_segment_geometry")
    con = _con()
    try:
        rows = con.execute(
            f"""
            SELECT s.from_stop, s.to_stop, s.wt_speed_mph, s.n_trips, s.seg_miles, s.borough,
                   g.from_lat, g.from_lon, g.to_lat, g.to_lon
            FROM read_parquet('{seg_file}') s
            LEFT JOIN read_parquet('{geom_file}') g
              ON g.route_id = s.route_id AND g.from_stop = s.from_stop AND g.to_stop = s.to_stop
            WHERE s.route_id = ?
            """,
            [route_id],
        ).fetchall()
    except Exception:
        rows = []
    finally:
        con.close()

    placed = [r for r in rows if r[6] is not None and r[8] is not None and r[2] is not None]
    speeds = sorted(float(r[2]) for r in placed)
    n = len(speeds)

    def pctile(v: float) -> float:
        # fraction of segments strictly slower (0 = slowest, 1 = fastest)
        if n <= 1:
            return 0.5
        lo = sum(1 for s in speeds if s < v)
        return round(lo / (n - 1), 4)

    median_speed = round(speeds[n // 2], 2) if n else None
    segments = []
    for r in placed:
        spd = float(r[2])
        segments.append({
            "from_stop": r[0], "to_stop": r[1],
            "wt_speed_mph": round(spd, 2),
            "speed_pctile": pctile(spd),
            "n_trips": int(r[3]) if r[3] is not None else None,
            "seg_miles": round(r[4], 3) if r[4] is not None else None,
            "borough": r[5],
            "coords": [[round(r[6], 6), round(r[7], 6)], [round(r[8], 6), round(r[9], 6)]],
        })
    # order slowest-first so slow segments paint on top
    segments.sort(key=lambda s: s["speed_pctile"])
    return {
        "route": route_id,
        "meta": _route_meta(route_id),
        "n_segments": len(rows),
        "n_placed": len(segments),
        "route_median_speed_mph": median_speed,
        "speed_domain": {"basis": "within_route_percentile", "min_mph": round(speeds[0], 2) if n else None,
                         "max_mph": round(speeds[-1], 2) if n else None},
        "width_basis": "constant_color_only",
        "width_note": (
            "Line width is constant (color-only). Per-segment passenger ridership is not "
            "derivable from the source (02_all_segments_peak carries bus trip counts, not APC "
            "boardings), so no ridership width is shown rather than fabricate an allocation."
        ),
        "color_note": "Color = peak weighted through-speed as a percentile within this route (diverging around the route median).",
        "segments": segments,
        "archive": _archive_meta(),
        "elapsed_ms": round((time.time() - t0) * 1000, 1),
    }


@router.get("/ribbon")
async def obs_ribbon(route: str) -> JSONResponse:
    data = _cached(f"ribbon|{route}", 600, lambda: _ribbon_payload(route))
    return JSONResponse(data)
