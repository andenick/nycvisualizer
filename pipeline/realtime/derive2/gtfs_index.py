#!/usr/bin/env python3
"""
derive2 — GTFS static index builder (shared by trajectories / headways / adherence / kpis).

Builds and caches, under realtime/derive2/cache/, the joins that every stage needs:

  trip_meta.parquet            trip_id -> feed, route_id, direction_id, shape_id, service_id
  routes.parquet               route_id -> feed, short/long name, color
  shape_points_2263.parquet    shape_id, seq, x_ft, y_ft   (shape geometry projected to 2263)
  stop_offsets.parquet         shape_id, stop_id, stop_offset_ft, stop_seq  (each stop projected
                               onto its shape via shapely line-locate)
  scheduled_stop_times.parquet trip_id, stop_id, stop_seq, sched_arr_sec, sched_dep_sec
  calendar.parquet             service_id, mon..sun, start_date, end_date
  calendar_dates.parquet       service_id, yyyymmdd, exception_type

Realtime bus trip_id joins to GTFS trips.txt at ~99.4% (verified), so shape + schedule
come straight from the static join — no fragile map-matching is needed for the schedule
side; map-matching (projection) is used only to place pings and stops on the shape.
"""
from __future__ import annotations

import argparse
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely import line_locate_point, points as shp_points
from shapely.geometry import LineString

from _common import (BUS_GTFS_FEEDS, CACHE, CRS_MEASURE, CRS_WGS84, STATIC_ROOT, now_iso)

_TF = Transformer.from_crs(CRS_WGS84, CRS_MEASURE, always_xy=True)


def _gtfs_dir(feed: str) -> Path:
    return STATIC_ROOT / feed / "gtfs"


def _read_csv(con: duckdb.DuckDBPyConnection, path: Path) -> pd.DataFrame:
    return con.execute(
        f"SELECT * FROM read_csv_auto('{path.as_posix()}', header=true, ALL_VARCHAR=true)"
    ).df()


def _build_trip_meta(con) -> pd.DataFrame:
    frames = []
    for feed in BUS_GTFS_FEEDS:
        tp = _gtfs_dir(feed) / "trips.txt"
        if not tp.exists():
            continue
        df = _read_csv(con, tp)
        df = df[["route_id", "service_id", "trip_id", "direction_id", "shape_id"]].copy()
        df["feed"] = feed
        frames.append(df)
    out = pd.concat(frames, ignore_index=True)
    out["direction_id"] = pd.to_numeric(out["direction_id"], errors="coerce").astype("Int64")
    return out


def _build_routes(con) -> pd.DataFrame:
    frames = []
    for feed in BUS_GTFS_FEEDS:
        rp = _gtfs_dir(feed) / "routes.txt"
        if not rp.exists():
            continue
        df = _read_csv(con, rp)
        keep = {c: c for c in ["route_id", "route_short_name", "route_long_name",
                               "route_color", "route_text_color", "route_type"]
                if c in df.columns}
        df = df[list(keep)].copy()
        df["feed"] = feed
        frames.append(df)
    return pd.concat(frames, ignore_index=True)


def _build_shape_points(con) -> pd.DataFrame:
    frames = []
    for feed in BUS_GTFS_FEEDS:
        sp = _gtfs_dir(feed) / "shapes.txt"
        if not sp.exists():
            continue
        df = _read_csv(con, sp)
        df["shape_pt_lat"] = pd.to_numeric(df["shape_pt_lat"], errors="coerce")
        df["shape_pt_lon"] = pd.to_numeric(df["shape_pt_lon"], errors="coerce")
        df["shape_pt_sequence"] = pd.to_numeric(df["shape_pt_sequence"], errors="coerce")
        df = df.dropna(subset=["shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"])
        frames.append(df[["shape_id", "shape_pt_lat", "shape_pt_lon", "shape_pt_sequence"]])
    allp = pd.concat(frames, ignore_index=True)
    x, y = _TF.transform(allp["shape_pt_lon"].to_numpy(), allp["shape_pt_lat"].to_numpy())
    allp["x_ft"] = x
    allp["y_ft"] = y
    allp = allp.rename(columns={"shape_pt_sequence": "seq"})
    return allp[["shape_id", "seq", "x_ft", "y_ft"]].sort_values(["shape_id", "seq"])


def build_shape_lines(shape_points: pd.DataFrame) -> dict[str, LineString]:
    """shape_id -> shapely LineString in EPSG:2263 (feet)."""
    lines: dict[str, LineString] = {}
    for sid, g in shape_points.groupby("shape_id", sort=False):
        if len(g) < 2:
            continue
        coords = list(zip(g["x_ft"].to_numpy(), g["y_ft"].to_numpy()))
        lines[sid] = LineString(coords)
    return lines


def _build_scheduled_stop_times(con) -> pd.DataFrame:
    frames = []
    for feed in BUS_GTFS_FEEDS:
        st = _gtfs_dir(feed) / "stop_times.txt"
        if not st.exists():
            continue
        df = con.execute(f"""
            SELECT CAST(trip_id AS VARCHAR) trip_id,
                   CAST(stop_id AS VARCHAR) stop_id,
                   CAST(stop_sequence AS INTEGER) stop_seq,
                   CAST(split_part(arrival_time,':',1) AS INTEGER)*3600
                     + CAST(split_part(arrival_time,':',2) AS INTEGER)*60
                     + CAST(split_part(arrival_time,':',3) AS INTEGER) AS sched_arr_sec,
                   CAST(split_part(departure_time,':',1) AS INTEGER)*3600
                     + CAST(split_part(departure_time,':',2) AS INTEGER)*60
                     + CAST(split_part(departure_time,':',3) AS INTEGER) AS sched_dep_sec
            FROM read_csv_auto('{st.as_posix()}', header=true, ALL_VARCHAR=true)
        """).df()
        frames.append(df)
    return pd.concat(frames, ignore_index=True)


def _build_stop_offsets(shape_points: pd.DataFrame, trip_meta: pd.DataFrame,
                        sched: pd.DataFrame, stops_xy: pd.DataFrame) -> pd.DataFrame:
    """Project each stop that appears on a shape onto that shape -> offset (ft).

    (shape_id, stop_id) pairs come from trips (shape_id) x their scheduled stop_times.
    Each stop's projected offset along the shape is computed with shapely line-locate.
    """
    lines = build_shape_lines(shape_points)
    # distinct (shape_id, stop_id, min stop_seq) via trip_meta x sched
    tm = trip_meta[["trip_id", "shape_id"]].dropna()
    pairs = (sched.merge(tm, on="trip_id", how="inner")
                  .groupby(["shape_id", "stop_id"], as_index=False)["stop_seq"].min())
    pairs = pairs.merge(stops_xy, on="stop_id", how="inner")
    rows = []
    for sid, g in pairs.groupby("shape_id", sort=False):
        line = lines.get(sid)
        if line is None:
            continue
        pts = shp_points(np.c_[g["x_ft"].to_numpy(), g["y_ft"].to_numpy()])
        offs = line_locate_point(line, pts)
        gg = g.copy()
        gg["stop_offset_ft"] = offs
        rows.append(gg[["shape_id", "stop_id", "stop_seq", "stop_offset_ft"]])
    return pd.concat(rows, ignore_index=True) if rows else pd.DataFrame(
        columns=["shape_id", "stop_id", "stop_seq", "stop_offset_ft"])


def _build_stops_xy(con) -> pd.DataFrame:
    frames = []
    for feed in BUS_GTFS_FEEDS:
        sp = _gtfs_dir(feed) / "stops.txt"
        if not sp.exists():
            continue
        df = _read_csv(con, sp)
        df["stop_lat"] = pd.to_numeric(df["stop_lat"], errors="coerce")
        df["stop_lon"] = pd.to_numeric(df["stop_lon"], errors="coerce")
        df = df.dropna(subset=["stop_lat", "stop_lon"])
        frames.append(df[["stop_id", "stop_name", "stop_lat", "stop_lon"]])
    allp = pd.concat(frames, ignore_index=True).drop_duplicates("stop_id")
    x, y = _TF.transform(allp["stop_lon"].to_numpy(), allp["stop_lat"].to_numpy())
    allp["x_ft"] = x
    allp["y_ft"] = y
    return allp


def _build_calendar(con):
    cal_frames, cd_frames = [], []
    for feed in BUS_GTFS_FEEDS:
        cp = _gtfs_dir(feed) / "calendar.txt"
        if cp.exists():
            cal_frames.append(_read_csv(con, cp))
        cdp = _gtfs_dir(feed) / "calendar_dates.txt"
        if cdp.exists():
            cd_frames.append(_read_csv(con, cdp))
    cal = pd.concat(cal_frames, ignore_index=True).drop_duplicates("service_id") if cal_frames else pd.DataFrame()
    cd = pd.concat(cd_frames, ignore_index=True) if cd_frames else pd.DataFrame(
        columns=["service_id", "date", "exception_type"])
    return cal, cd


def ensure_index(rebuild: bool = False) -> dict:
    """Build (or reuse) all cached GTFS index parquet files. Returns a small report."""
    CACHE.mkdir(parents=True, exist_ok=True)
    targets = ["trip_meta", "routes", "shape_points_2263", "stop_offsets",
               "scheduled_stop_times", "calendar", "calendar_dates"]
    if not rebuild and all((CACHE / f"{t}.parquet").exists() for t in targets):
        return {"status": "cached", "cache": CACHE.as_posix()}

    con = duckdb.connect()
    trip_meta = _build_trip_meta(con)
    routes = _build_routes(con)
    shape_points = _build_shape_points(con)
    sched = _build_scheduled_stop_times(con)
    stops_xy = _build_stops_xy(con)
    stop_offsets = _build_stop_offsets(shape_points, trip_meta, sched, stops_xy)
    cal, cd = _build_calendar(con)

    trip_meta.to_parquet(CACHE / "trip_meta.parquet", index=False)
    routes.to_parquet(CACHE / "routes.parquet", index=False)
    shape_points.to_parquet(CACHE / "shape_points_2263.parquet", index=False)
    stop_offsets.to_parquet(CACHE / "stop_offsets.parquet", index=False)
    sched.to_parquet(CACHE / "scheduled_stop_times.parquet", index=False)
    cal.to_parquet(CACHE / "calendar.parquet", index=False)
    cd.to_parquet(CACHE / "calendar_dates.parquet", index=False)
    stops_xy[["stop_id", "stop_name"]].to_parquet(CACHE / "stops.parquet", index=False)

    return {
        "status": "built", "built_at": now_iso(), "cache": CACHE.as_posix(),
        "trips": int(len(trip_meta)), "routes": int(routes["route_id"].nunique()),
        "shapes": int(shape_points["shape_id"].nunique()),
        "stop_offsets": int(len(stop_offsets)),
        "scheduled_stop_times": int(len(sched)),
        "services": int(len(cal)),
    }


def load_cache() -> dict[str, pd.DataFrame]:
    d = {}
    for t in ["trip_meta", "routes", "shape_points_2263", "stop_offsets",
              "scheduled_stop_times", "calendar", "calendar_dates", "stops"]:
        p = CACHE / f"{t}.parquet"
        if p.exists():
            d[t] = pd.read_parquet(p)
    return d


_WEEKDAY_COLS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]


def active_services_for_date(cal: pd.DataFrame, cd: pd.DataFrame, ymd: str) -> set[str]:
    """Resolve the set of active GTFS service_ids for a calendar date 'YYYY-MM-DD'."""
    d = pd.Timestamp(ymd)
    ymd_int = d.strftime("%Y%m%d")
    dow = _WEEKDAY_COLS[d.weekday()]
    active: set[str] = set()
    if not cal.empty and dow in cal.columns:
        c = cal.copy()
        c["start_date"] = c["start_date"].astype(str)
        c["end_date"] = c["end_date"].astype(str)
        mask = (c[dow].astype(str) == "1") & (c["start_date"] <= ymd_int) & (c["end_date"] >= ymd_int)
        active |= set(c.loc[mask, "service_id"].astype(str))
    if not cd.empty:
        ex = cd.copy()
        ex["date"] = ex["date"].astype(str)
        ex = ex[ex["date"] == ymd_int]
        active |= set(ex.loc[ex["exception_type"].astype(str) == "1", "service_id"].astype(str))
        active -= set(ex.loc[ex["exception_type"].astype(str) == "2", "service_id"].astype(str))
    return active


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuild", action="store_true")
    args = ap.parse_args()
    import json
    print(json.dumps(ensure_index(rebuild=args.rebuild), indent=2))
