#!/usr/bin/env python3
"""
derive2 stage 3b — geographic ROUTE adherence + the per-route x segment speed table.

Two honest, cheap products off the bus vehicle-position archive + GTFS shapes:

1. ROUTE ADHERENCE  (derived/route_adherence/date=YYYY-MM-DD/part-000.parquet)
   Per route x day: the share of GPS pings that fall within ADHERENCE_ONROUTE_FT (100 ft)
   of the trip's own GTFS shape. Each ping is projected onto its trip's shape (EPSG:2263,
   feet) and its PERPENDICULAR distance to the shape is measured. The first/last
   ADHERENCE_TERMINAL_FT (500 ft) of every trip are excluded (layover / terminal-loop GPS
   noise inflates off-route there). Off-route = detour / reroute / GPS-noise signal.
   Honest caveats: GPS noise floor, terminals excluded, unmatched trips (no GTFS shape)
   simply do not contribute pings.

2. SPEED TABLE      (derived/route_segment_speeds/{segment,route}-000.parquet)
   Consolidated over ALL archive days from the resampled trajectories (stage 1). Along-shape
   speed = d(offset_ft)/d(ts) on the 30 s grid, kept only when physically sane
   (SPEED_SANE_MIN_FPS..SPEED_SANE_MAX_FPS). Median speed per
   (route_id, direction_id, seg_bin) where seg_bin = floor(offset_ft / SEG_BIN_FT), plus a
   per-route median fallback. The API (site/backend/app/motion.py) loads this once to blend
   speed_est_fps when a bus's own observed displacement is unavailable/insane.

current_status is 100 % NULL in this archive (S0) so nothing here relies on STOPPED_AT.
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
from shapely import distance as shp_distance, line_locate_point, points as shp_points

from _common import (ADHERENCE_ONROUTE_FT, ADHERENCE_TERMINAL_FT, ARCHIVE, CRS_MEASURE,
                     CRS_WGS84, ROUTE_ADHERENCE_DIR, ROUTE_SPEED_DIR, SEG_BIN_FT,
                     SPEED_SANE_MAX_FPS, SPEED_SANE_MIN_FPS, TRAJ_DIR, duck_list, now_iso)
from gtfs_index import build_shape_lines, ensure_index, load_cache

_TF = Transformer.from_crs(CRS_WGS84, CRS_MEASURE, always_xy=True)


def _day_files(day: str) -> list[Path]:
    return [Path(f) for f in glob.glob(
        str(ARCHIVE / "bus_vehicle_positions" / f"date={day}" / "**" / "*.parquet"),
        recursive=True)]


# --------------------------------------------------------------------- route adherence
def process_day(day: str, cache: dict | None = None) -> dict:
    """Compute per-route on-route adherence for one archive day."""
    files = _day_files(day)
    stats = dict(day=day, run_at=now_iso(), input_files=len(files))
    out_dir = ROUTE_ADHERENCE_DIR / f"date={day}"
    if not files:
        stats["status"] = "no_input"
        return stats
    if cache is None:
        cache = load_cache()
    trip_meta = cache["trip_meta"][["trip_id", "shape_id", "direction_id", "route_id", "feed"]]
    shape_pts = cache["shape_points_2263"]

    con = duckdb.connect()
    df = con.execute(f"""
        SELECT trip_id, route_id AS rt_route_id, lat, lon
        FROM read_parquet({duck_list(files)}, union_by_name=true)
        WHERE trip_id IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL
    """).df()
    con.close()
    stats["raw_pings"] = int(len(df))

    df = df.merge(trip_meta, on="trip_id", how="left")
    matched = df["shape_id"].notna()
    stats["pings_matched_shape"] = int(matched.sum())
    df = df[matched].copy()
    df["route_id"] = df["route_id"].fillna(df["rt_route_id"])
    if df.empty:
        stats["status"] = "no_matched_pings"
        return stats

    # project every ping to its shape: perpendicular distance (ft) + along-shape offset (ft)
    x, y = _TF.transform(df["lon"].to_numpy(), df["lat"].to_numpy())
    df["x_ft"], df["y_ft"] = x, y
    lines = build_shape_lines(shape_pts)
    shape_len = {sid: ln.length for sid, ln in lines.items()}
    df["perp_ft"] = np.nan
    df["offset_ft"] = np.nan
    for sid, g in df.groupby("shape_id", sort=False):
        line = lines.get(sid)
        if line is None:
            continue
        pts = shp_points(np.c_[g["x_ft"].to_numpy(), g["y_ft"].to_numpy()])
        df.loc[g.index, "perp_ft"] = shp_distance(pts, line)
        df.loc[g.index, "offset_ft"] = line_locate_point(line, pts)
    df = df.dropna(subset=["perp_ft", "offset_ft"])

    # exclude the first/last 500 ft of each trip's shape (terminal / layover noise)
    df["shape_len_ft"] = df["shape_id"].map(shape_len)
    keep = (df["offset_ft"] >= ADHERENCE_TERMINAL_FT) & \
           (df["offset_ft"] <= df["shape_len_ft"] - ADHERENCE_TERMINAL_FT)
    n_terminal_excluded = int((~keep).sum())
    df = df[keep].copy()
    if df.empty:
        stats["status"] = "no_pings_after_terminal_exclude"
        return stats

    df["on_route"] = (df["perp_ft"] <= ADHERENCE_ONROUTE_FT)
    grp = df.groupby("route_id")
    rows = grp.agg(
        n_pings=("on_route", "size"),
        n_on_route=("on_route", "sum"),
        median_perp_ft=("perp_ft", "median"),
        p90_perp_ft=("perp_ft", lambda s: float(np.percentile(s, 90))),
        n_trips=("trip_id", "nunique"),
    ).reset_index()
    rows["adherence_pct"] = (100.0 * rows["n_on_route"] / rows["n_pings"]).round(3)
    rows["day"] = day
    rows = rows.sort_values("route_id")

    out_dir.mkdir(parents=True, exist_ok=True)
    rows.to_parquet(out_dir / "part-000.parquet", index=False)
    stats.update(
        status="ok",
        routes=int(len(rows)),
        pings_scored=int(rows["n_pings"].sum()),
        terminal_pings_excluded=n_terminal_excluded,
        citywide_adherence_pct=round(100.0 * rows["n_on_route"].sum() / rows["n_pings"].sum(), 3),
        median_route_adherence_pct=round(float(rows["adherence_pct"].median()), 3),
        output=(out_dir / "part-000.parquet").as_posix(),
    )
    return stats


# ------------------------------------------------------------------ speed table (global)
def build_speed_table(days: list[str] | None = None) -> dict:
    """Consolidate along-shape speeds from ALL trajectory days into the small speed table."""
    if days is None:
        days = sorted(Path(p).name.split("=", 1)[1]
                      for p in glob.glob(str(TRAJ_DIR / "date=*")))
    stats = dict(run_at=now_iso(), days=days)
    frames = []
    for day in days:
        p = TRAJ_DIR / f"date={day}" / "part-000.parquet"
        if not p.exists():
            continue
        t = pd.read_parquet(p, columns=["trip_id", "route_id", "direction_id", "ts", "offset_ft"])
        if t.empty:
            continue
        t = t.sort_values(["trip_id", "ts"])
        # per-trip consecutive along-shape speed on the resampled grid
        d_off = t.groupby("trip_id")["offset_ft"].diff()
        d_ts = t.groupby("trip_id")["ts"].diff()
        spd = d_off / d_ts
        m = d_ts.notna() & (d_ts > 0) & spd.between(SPEED_SANE_MIN_FPS, SPEED_SANE_MAX_FPS)
        seg = pd.DataFrame({
            "route_id": t["route_id"].astype(str),
            "direction_id": pd.to_numeric(t["direction_id"], errors="coerce"),
            "seg_bin": (t["offset_ft"] // SEG_BIN_FT).astype("Int64"),
            "speed_fps": spd,
        })[m.to_numpy()]
        frames.append(seg)
    if not frames:
        stats["status"] = "no_trajectories"
        return stats
    allspd = pd.concat(frames, ignore_index=True)
    allspd = allspd.dropna(subset=["direction_id", "seg_bin"])
    allspd["direction_id"] = allspd["direction_id"].astype(int)
    allspd["seg_bin"] = allspd["seg_bin"].astype(int)

    seg_tbl = (allspd.groupby(["route_id", "direction_id", "seg_bin"])
               .agg(median_fps=("speed_fps", "median"), n=("speed_fps", "size"))
               .reset_index())
    route_tbl = (allspd.groupby("route_id")
                 .agg(median_fps=("speed_fps", "median"), n=("speed_fps", "size"))
                 .reset_index())
    seg_tbl["median_fps"] = seg_tbl["median_fps"].round(3)
    route_tbl["median_fps"] = route_tbl["median_fps"].round(3)

    ROUTE_SPEED_DIR.mkdir(parents=True, exist_ok=True)
    seg_tbl.to_parquet(ROUTE_SPEED_DIR / "segment-000.parquet", index=False)
    route_tbl.to_parquet(ROUTE_SPEED_DIR / "route-000.parquet", index=False)
    (ROUTE_SPEED_DIR / "META.json").write_text(json.dumps({
        "built_at": now_iso(), "days": days, "seg_bin_ft": SEG_BIN_FT,
        "speed_sane_fps": [SPEED_SANE_MIN_FPS, SPEED_SANE_MAX_FPS],
        "segment_rows": int(len(seg_tbl)), "route_rows": int(len(route_tbl)),
        "observations": int(len(allspd)),
        "citywide_median_fps": round(float(allspd["speed_fps"].median()), 3),
    }, indent=2))
    stats.update(status="ok", segment_rows=int(len(seg_tbl)), route_rows=int(len(route_tbl)),
                 observations=int(len(allspd)),
                 citywide_median_fps=round(float(allspd["speed_fps"].median()), 3),
                 output=ROUTE_SPEED_DIR.as_posix())
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", help="YYYY-MM-DD (route-adherence for one day)")
    ap.add_argument("--speed-table", action="store_true",
                    help="(re)build the consolidated per-route x segment speed table")
    ap.add_argument("--backfill", action="store_true",
                    help="route-adherence for every archive day + rebuild the speed table")
    args = ap.parse_args()
    ensure_index()
    cache = load_cache()
    out = {}
    if args.backfill:
        days = sorted(p.name.split("=", 1)[1]
                      for p in [Path(x) for x in glob.glob(
                          str(ARCHIVE / "bus_vehicle_positions" / "date=*"))])
        out["adherence"] = {d: process_day(d, cache=cache) for d in days}
        out["speed_table"] = build_speed_table()
    else:
        if args.day:
            out["adherence"] = process_day(args.day, cache=cache)
        if args.speed_table:
            out["speed_table"] = build_speed_table()
    print(json.dumps(out, indent=2, default=str))


if __name__ == "__main__":
    main()
