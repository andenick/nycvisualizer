#!/usr/bin/env python3
"""
derive2 stage 1 — trip trajectory builder.

Archive bus vehicle-positions -> per-trip distance-along-shape (shape offset) time series:
  * join RT trip_id to GTFS trips.txt (shape ownership; ~99.4% match)
  * project each GPS ping to its shape offset in EPSG:2263 (shapely line-locate)
  * monotonic-offset filter (tolerate GPS jitter up to MONO_BACKTRACK_FT; flag + count
    non-monotonic pings and unmatched / too-short trips honestly)
  * resample the surviving series to a regular RESAMPLE_S (30s) grid by linear interpolation

Output: derived/trajectories/date=YYYY-MM-DD/part-000.parquet
Columns: trip_id, route_id, direction_id, shape_id, feed, ts, offset_ft, frac_along
         (frac_along = offset / shape_length, the Marey y-axis coordinate in [0,1])

current_status is 100% NULL in this archive (S0) so nothing here relies on STOPPED_AT.
"""
from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from pyproj import Transformer
from shapely import line_locate_point, points as shp_points

from _common import (ARCHIVE, CRS_MEASURE, CRS_WGS84, MONO_BACKTRACK_FT, RESAMPLE_S,
                     TRAJ_DIR, duck_list, now_iso)
from gtfs_index import build_shape_lines, ensure_index, load_cache

_TF = Transformer.from_crs(CRS_WGS84, CRS_MEASURE, always_xy=True)


def _day_files(day: str) -> list[Path]:
    return [Path(f) for f in glob.glob(
        str(ARCHIVE / "bus_vehicle_positions" / f"date={day}" / "**" / "*.parquet"),
        recursive=True)]


def process_day(day: str, cache: dict | None = None) -> dict:
    files = _day_files(day)
    stats = dict(day=day, run_at=now_iso(), input_files=len(files))
    out_dir = TRAJ_DIR / f"date={day}"
    if not files:
        stats["status"] = "no_input"
        return stats

    if cache is None:
        cache = load_cache()
    trip_meta = cache["trip_meta"][["trip_id", "shape_id", "direction_id", "route_id", "feed"]]
    shape_pts = cache["shape_points_2263"]

    con = duckdb.connect()
    df = con.execute(f"""
        SELECT trip_id, route_id AS rt_route_id, vehicle_id,
               CAST(COALESCE(timestamp, poll_ts) AS BIGINT) AS ts, lat, lon
        FROM read_parquet({duck_list(files)}, union_by_name=true)
        WHERE trip_id IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL
    """).df()
    con.close()
    stats["raw_pings"] = int(len(df))
    stats["raw_trips"] = int(df["trip_id"].nunique())

    # de-dup exact (trip, ts) repeats (poller re-reports)
    df = df.drop_duplicates(["trip_id", "ts"])

    # join to GTFS for shape ownership
    df = df.merge(trip_meta, on="trip_id", how="left")
    matched = df["shape_id"].notna()
    stats["pings_matched_shape"] = int(matched.sum())
    stats["trips_unmatched_no_gtfs"] = int(df.loc[~matched, "trip_id"].nunique())
    df = df[matched].copy()
    df["route_id"] = df["route_id"].fillna(df["rt_route_id"])

    # project pings to 2263 once (vectorized)
    x, y = _TF.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    df["x_ft"], df["y_ft"] = x, y

    # shape offset via line-locate, grouped by shape (vectorized per shape)
    lines = build_shape_lines(shape_pts)
    shape_len = {sid: ln.length for sid, ln in lines.items()}
    df["offset_ft"] = np.nan
    for sid, g in df.groupby("shape_id", sort=False):
        line = lines.get(sid)
        if line is None:
            continue
        pts = shp_points(np.c_[g["x_ft"].to_numpy(), g["y_ft"].to_numpy()])
        df.loc[g.index, "offset_ft"] = line_locate_point(line, pts)
    df = df.dropna(subset=["offset_ft"])

    # per-trip: monotonic filter + 30s resample
    out_rows = []
    n_nonmono = 0
    n_trips_ok = 0
    n_trips_short = 0
    df = df.sort_values(["trip_id", "ts"])
    for tid, g in df.groupby("trip_id", sort=False):
        ts = g["ts"].to_numpy(dtype=np.int64)
        off = g["offset_ft"].to_numpy(dtype=np.float64)
        if len(ts) < 2:
            n_trips_short += 1
            continue
        # monotonic-increasing filter with backtrack tolerance
        keep = np.ones(len(off), dtype=bool)
        runmax = off[0]
        for i in range(1, len(off)):
            if off[i] < runmax - MONO_BACKTRACK_FT:
                keep[i] = False
            else:
                runmax = max(runmax, off[i])
        n_nonmono += int((~keep).sum())
        ts_k, off_k = ts[keep], off[keep]
        # collapse duplicate timestamps after filtering
        _, uidx = np.unique(ts_k, return_index=True)
        ts_k, off_k = ts_k[uidx], off_k[uidx]
        if len(ts_k) < 2:
            n_trips_short += 1
            continue
        # enforce non-decreasing offset for interpolation
        off_k = np.maximum.accumulate(off_k)
        grid = np.arange(int(np.ceil(ts_k[0] / RESAMPLE_S) * RESAMPLE_S),
                         ts_k[-1] + 1, RESAMPLE_S, dtype=np.int64)
        if len(grid) == 0:
            n_trips_short += 1
            continue
        g_off = np.interp(grid, ts_k, off_k)
        row0 = g.iloc[0]
        sid = row0["shape_id"]
        slen = shape_len.get(sid, np.nan)
        frac = g_off / slen if slen and slen > 0 else np.nan
        out_rows.append(pd.DataFrame({
            "trip_id": tid, "route_id": row0["route_id"],
            "direction_id": row0["direction_id"], "shape_id": sid, "feed": row0["feed"],
            "ts": grid, "offset_ft": g_off, "frac_along": frac,
        }))
        n_trips_ok += 1

    stats.update(trips_with_trajectory=n_trips_ok, trips_too_few_points=n_trips_short,
                 non_monotonic_pings=n_nonmono,
                 non_monotonic_rate=round(n_nonmono / max(1, stats["pings_matched_shape"]), 4),
                 unmatched_trip_rate=round(
                     stats["trips_unmatched_no_gtfs"] / max(1, stats["raw_trips"]), 4))

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "part-000.parquet"
    if out_rows:
        res = pd.concat(out_rows, ignore_index=True)
        res.to_parquet(out_path, index=False)
        stats["output_rows"] = int(len(res))
        stats["output"] = out_path.as_posix()
    else:
        # write empty marker so idempotent orchestrator knows the day was processed
        pd.DataFrame(columns=["trip_id", "route_id", "direction_id", "shape_id", "feed",
                              "ts", "offset_ft", "frac_along"]).to_parquet(out_path, index=False)
        stats["output_rows"] = 0
        stats["output"] = out_path.as_posix()
    stats["status"] = "ok"
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True, help="YYYY-MM-DD")
    args = ap.parse_args()
    ensure_index()
    print(json.dumps(process_day(args.day), indent=2))


if __name__ == "__main__":
    main()
